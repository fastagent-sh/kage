// Copied out of the repository: inside it, a module missing from app.asar resolves from node_modules anyway.
// Checks bundle completeness, a real run against a local model, and the single-instance handoff.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractAll } from "@electron/asar";
import { chunk, requireFreshBuild, withoutCredentials, writeMockAgent } from "./harness.mjs";
import { driver } from "./window.mjs";

const built = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "mac-arm64", "duang.app");
// The packaged app, not `out/`: `npm run package` refreshes it, and a source edit makes it stale.
requireFreshBuild([join(built, "Contents", "Resources", "app.asar")], "npm run package");
const root = mkdtempSync(join(tmpdir(), "duang-packaged-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Peers a bundled package declares but nothing duang runs imports. Each needs its reason.
const UNUSED = {
  // Only NodeRedis.js imports it. FastAgent loads the NodeHttpServer subpath, inside serve(), which duang never calls.
  "@effect/platform-node": ["redis"],
};

function missingDependencies(bundle) {
  const packages = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      if (name.startsWith("@")) walk(path);
      else if (existsSync(join(path, "package.json"))) {
        packages.push(path);
        walk(join(path, "node_modules"));
      }
    }
  };
  walk(join(bundle, "node_modules"));
  const resolves = (from, dependency) => {
    for (let dir = from; dir.startsWith(bundle); dir = dirname(dir))
      if (existsSync(join(dir, "node_modules", dependency, "package.json"))) return true;
    return false;
  };
  const missing = [];
  for (const path of packages) {
    const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    const optional = new Set([
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.entries(manifest.peerDependenciesMeta ?? {}).flatMap(([name, meta]) => (meta.optional ? [name] : [])),
    ]);
    for (const dependency of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])
      if (!optional.has(dependency) && !(UNUSED[manifest.name] ?? []).includes(dependency) && !resolves(path, dependency))
        missing.push(`${dependency}, needed by ${path.slice(bundle.length + 1)}`);
  }
  return { checked: packages.length, missing };
}

/** A local model: the first answer calls bash, the second answers. */
let calls = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (calls === 1) {
      res.write(chunk({ role: "assistant", content: "Checking.", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo installed > proof.txt" }) } }] }));
      res.write(chunk({}, "tool_calls"));
    } else {
      res.write(chunk({ role: "assistant", content: "Installed answer." }));
      res.write(chunk({}, "stop"));
    }
    res.end("data: [DONE]\n\n");
  });
});

const children = [];
function launch(app, data) {
  const env = withoutCredentials({ ...process.env, HOME: root });
  const child = spawn(app, [`--user-data-dir=${data}`, "--remote-debugging-port=0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  children.push(child);
  return { child, output: () => output };
}

async function run() {
  // 1. The bundle is complete.
  const bundle = join(root, "bundle");
  extractAll(join(built, "Contents", "Resources", "app.asar"), bundle);
  const unpacked = join(built, "Contents", "Resources", "app.asar.unpacked");
  if (existsSync(unpacked)) cpSync(unpacked, bundle, { recursive: true });
  const { checked, missing } = missingDependencies(bundle);
  assert.deepEqual(missing, [], `app.asar is missing modules (found only through the repository's node_modules)`);

  // 2. The app runs outside the repository.
  const installed = join(root, "Applications", "duang.app");
  cpSync(built, installed, { recursive: true, verbatimSymlinks: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const data = join(root, "user-data");
  const project = join(root, "project");
  mkdirSync(data, { recursive: true });
  // The agent's own modules are the app's: the one place outside the repository that has pi-ai.
  writeMockAgent(project, server.address().port, { modules: join(bundle, "node_modules") });
  writeFileSync(join(data, "agents.json"), JSON.stringify([{ id: "p", name: "Installed", dir: project, colour: 2 }]));
  const binary = join(installed, "Contents", "MacOS", "duang");
  const first = launch(binary, data);

  // Chromium writes the port it chose to DevToolsActivePort in the profile.
  let page;
  let port;
  for (let t = 0; t < 300 && !page; t++) {
    await sleep(100);
    const file = join(data, "DevToolsActivePort");
    if (!existsSync(file)) continue;
    port = readFileSync(file, "utf8").split("\n")[0];
    page = await fetch(`http://127.0.0.1:${port}/json`)
      .then((r) => r.json())
      .then((targets) => targets.find((target) => target.type === "page"))
      .catch(() => undefined);
  }
  assert.ok(page, `the installed app opened no window:\n${first.output()}`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (message) => {
    const reply = JSON.parse(message.data);
    pending.get(reply.id)?.(reply);
  });
  // A script that throws rejects with what it threw, rather than reading as undefined.
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (reply) => {
        const thrown = reply.result?.exceptionDetails;
        if (thrown) reject(new Error(`${expression}\n${thrown.exception?.description ?? thrown.text}`));
        else resolve(reply.result?.result?.value);
      });
      socket.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  // The window is another process here, reached over the DevTools protocol, so only the driving is shared.
  const { until, send } = driver(evaluate, { timeout: 30000, poll: 100, dump: () => first.output() });

  // The page is listed as soon as the window exists, before its preload has run: wait for the app's API.
  await until("typeof window.duang?.listAgents === 'function'", "the window's preload API");
  assert.equal(await evaluate("window.duang.listAgents().then((agents) => agents.map((a) => a.name).join())"), "Installed", "the isolated profile");
  await send("go");
  await until("document.querySelector('main').innerText.includes('Installed answer.')", "the answer");
  assert.equal(readFileSync(join(project, "proof.txt"), "utf8").trim(), "installed", "bash ran in the project");

  // 3. A second duang shows the first and leaves, also when the first has no window left.
  const pages = () =>
    fetch(`http://127.0.0.1:${port}/json`)
      .then((r) => r.json())
      .then((targets) => targets.filter((target) => target.type === "page").length);
  // The page goes with its window, so its reply never comes.
  void evaluate("window.close()");
  for (let t = 0; t < 50 && (await pages()) > 0; t++) await sleep(100);
  assert.equal(await pages(), 0, "the first duang's window closed, the app still running");
  assert.equal(first.child.exitCode, null);
  const second = launch(binary, data);
  const code = await Promise.race([new Promise((resolve) => second.child.on("exit", resolve)), sleep(20000).then(() => "still running")]);
  assert.equal(code, 0, `a second duang on the same profile leaves: ${second.output()}`);
  assert.match(second.output(), /already running/);
  for (let t = 0; t < 100 && (await pages()) === 0; t++) await sleep(100);
  assert.equal(await pages(), 1, "the first one shows a window again");
  console.log(`Packaged app passed: ${checked} bundled packages complete, an agent answered with a bash call outside the repository, one duang per profile.`);
}

const timeout = setTimeout(() => {
  console.error("Packaged check timed out");
  process.exit(1);
}, 150000);
run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    clearTimeout(timeout);
    server.close();
    for (const child of children) child.kill();
    await sleep(500);
    rmSync(root, { recursive: true, force: true });
  });
