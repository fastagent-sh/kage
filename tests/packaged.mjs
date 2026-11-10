// Copied out of the repository: inside it, a module missing from app.asar resolves from node_modules anyway.
// Checks bundle completeness, a real run against a local model, and the single-instance handoff.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractAll } from "@electron/asar";
import { buildMockProgram, chunk, requireFreshBuild, useModules, withoutCredentials, writeInstance } from "./harness.mjs";
import { driver } from "./window.mjs";

const built = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "mac-arm64", "kage.app");
// The packaged app, not `out/`: `npm run package` refreshes it, and a source edit makes it stale.
requireFreshBuild([join(built, "Contents", "Resources", "app.asar")], "npm run package");
const root = mkdtempSync(join(tmpdir(), "kage-packaged-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Peers a bundled package declares but nothing kage runs imports. Each needs its reason.
const UNUSED = {
  // Only NodeRedis.js imports it. FastAgent loads the NodeHttpServer subpath, inside serve(), which kage never calls.
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
function launch(app, data, extra = {}) {
  const env = withoutCredentials({ ...process.env, HOME: root, ...extra });
  const child = spawn(app, [`--user-data-dir=${data}`, "--remote-debugging-port=0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  children.push(child);
  return { child, output: () => output };
}

// Chromium writes the port it chose to DevToolsActivePort in the profile.
async function attach(launched, data) {
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
  assert.ok(page, `the installed app opened no window:\n${launched.output()}`);
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
  const { until, send } = driver(evaluate, { timeout: 30000, poll: 100, dump: () => launched.output() });

  return { evaluate, until, send, port };
}

async function run() {
  const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", join(built, "Contents", "Info.plist")], { encoding: "utf8" }));
  assert.equal(info.CFBundleIdentifier, "sh.fastagent.kage");
  assert.equal(info.CFBundleName, "kage");
  assert.equal(info.CFBundleExecutable, "kage");
  const bundle = join(root, "bundle");
  extractAll(join(built, "Contents", "Resources", "app.asar"), bundle);
  const manifest = JSON.parse(readFileSync(join(bundle, "package.json"), "utf8"));
  assert.equal(manifest.name, "kage");
  assert.ok(existsSync(join(dirname(dirname(built)), `kage-${manifest.version}-arm64.dmg`)));
  const unpacked = join(built, "Contents", "Resources", "app.asar.unpacked");
  if (existsSync(unpacked)) cpSync(unpacked, bundle, { recursive: true });
  const { checked, missing } = missingDependencies(bundle);
  assert.deepEqual(missing, [], `app.asar is missing modules (found only through the repository's node_modules)`);

  // 2. The app runs outside the repository.
  const installed = join(root, "Applications", "kage.app");
  cpSync(built, installed, { recursive: true, verbatimSymlinks: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const data = join(root, "user-data");
  const project = join(root, "project");
  mkdirSync(data, { recursive: true });
  // A program with a model of its own, on the modules the app holds: the one place outside the repository that has pi-ai.
  const mockProgram = buildMockProgram(root);
  useModules(root, join(bundle, "node_modules"));
  const mockEnv = { KAGE_PROGRAM_DIR: mockProgram, KAGE_MOCK_MODEL_URL: `http://127.0.0.1:${server.address().port}/v1` };
  writeInstance(project, { model: "mock/mock" });
  writeFileSync(join(data, "agents.json"), JSON.stringify([{ id: "p", name: "Installed", dir: project, colour: 2 }]));
  const binary = join(installed, "Contents", "MacOS", "kage");
  const first = launch(binary, data, mockEnv);

  const { evaluate, until, send, port } = await attach(first, data);

  // The page is listed as soon as the window exists, before its preload has run: wait for the app's API.
  await until("typeof window.kage?.listAgents === 'function'", "the window's preload API");
  assert.equal(await evaluate("document.title"), "kage");
  assert.equal(await evaluate("window.kage.listAgents().then((agents) => agents.map((a) => a.name).join())"), "Installed", "the isolated profile");
  await send("go");
  await until("document.querySelector('main').innerText.includes('Installed answer.')", "the answer");
  assert.equal(readFileSync(join(project, "proof.txt"), "utf8").trim(), "installed", "bash ran in the project");

  // 3. A second kage shows the first and leaves, also when the first has no window left.
  const pages = () =>
    fetch(`http://127.0.0.1:${port}/json`)
      .then((r) => r.json())
      .then((targets) => targets.filter((target) => target.type === "page").length);
  // The page goes with its window, so its reply never comes.
  void evaluate("window.close()");
  for (let t = 0; t < 50 && (await pages()) > 0; t++) await sleep(100);
  assert.equal(await pages(), 0, "the first kage's window closed, the app still running");
  assert.equal(first.child.exitCode, null);
  const second = launch(binary, data, mockEnv);
  const code = await Promise.race([new Promise((resolve) => second.child.on("exit", resolve)), sleep(20000).then(() => "still running")]);
  assert.equal(code, 0, `a second kage on the same profile leaves: ${second.output()}`);
  assert.match(second.output(), /already running/);
  for (let t = 0; t < 100 && (await pages()) === 0; t++) await sleep(100);
  assert.equal(await pages(), 1, "the first one shows a window again");
  first.child.kill();
  const exited = await Promise.race([new Promise((resolve) => first.child.on("exit", resolve)), sleep(10000).then(() => "still running")]);
  assert.equal(exited, 0, `the running app quits on SIGTERM: ${first.output()}`);

  // 4. The program the app ships opens an agent kage creates, with no program of the test's.
  assert.ok(existsSync(join(bundle, "program", "dist", "index.js")), "the app carries its program");
  const fresh = join(root, "user-data-shipped");
  mkdirSync(fresh, { recursive: true });
  const shipped = launch(binary, fresh);
  const window = await attach(shipped, fresh);
  await window.until("typeof window.kage?.createAgent === 'function'", "the window's preload API");
  const created = await window.evaluate("window.kage.createAgent('Shipped', [])");
  assert.equal(created.ok, true, created.error?.message);
  const opened = await window.evaluate(`window.kage.openAgent(${JSON.stringify(created.agent.id)})`);
  assert.equal(opened.ok, true, opened.message);
  assert.ok(opened.commands.some((command) => command.name === "skill:writing-great-skills"), "the shipped program's skill is offered");
  assert.ok(existsSync(join(root, "Agents", "Shipped", ".state")), "its conversations are kept in its folder");
  shipped.child.kill();
  console.log(`Packaged app passed: ${checked} bundled packages complete, an agent answered with a bash call outside the repository, one kage per profile, the shipped program opens a new agent.`);
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
    for (const child of children) child.kill("SIGKILL");
    await sleep(500);
    rmSync(root, { recursive: true, force: true });
  });
