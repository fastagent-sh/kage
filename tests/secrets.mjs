// A program that declares a variable it needs: the agent does not open until kage holds a value, the value is set
// in the window, and it reaches the agent's commands (and nothing else of kage's environment does). Then the
// network route changes under the open agent, and its next connection takes the route as it is.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import electron from "electron";
import { chunk, isolated, withoutCredentials, writeInstance } from "./harness.mjs";
import { open, windowDriver } from "./window.mjs";

const NAME = "KAGE_TEST_TOKEN";
const VALUE = "synthetic-token-value";

const root = await isolated(import.meta.url, {
  name: "secrets",
  timeout: 90000,
  program: { variables: { [NAME]: "A token the agent's commands read" } },
});
if (root) {
  const { app } = electron;
  withoutCredentials(process.env);
  const data = join(root, "user-data");
  const project = join(root, "project");
  mkdirSync(data, { recursive: true });
  app.setPath("userData", data);
  // Present in kage's environment and declared by nobody: it must not reach a command.
  process.env.KAGE_UNDECLARED = "leaked";

  // Each turn is a bash call, then an answer.
  const script = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const command = script.shift();
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (command) {
        res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ role: "assistant", content: "Checked." }));
        res.write(chunk({}, "stop"));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.KAGE_MOCK_MODEL_URL = `http://127.0.0.1:${server.address().port}/v1`;
  writeInstance(project, { model: "mock/mock" });
  writeFileSync(join(data, "agents.json"), JSON.stringify([{ id: "k", name: "Keys", dir: project, colour: 1 }]));

  const filesUnder = (dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && !entry.parentPath.includes(".git"));

  async function run() {
    const win = await open();
    const { evaluate, until, type, send } = windowDriver(win, { timeout: 30000, poll: 50 });
    await until("document.body.innerText.includes('missing required secrets')", "an agent missing a required value does not open");
    await evaluate(`document.querySelector('main > header button[aria-label="Agent details"]').click()`);
    await until(`document.querySelector('#agent-info')?.innerText.includes('${NAME}') && document.querySelector('#agent-info')?.innerText.includes('missing')`, "the inspector names the value that is missing");
    await evaluate(`[...document.querySelectorAll('#agent-info button')].find((b) => b.textContent.includes('${NAME}')).click()`);
    await type(VALUE, 'input[aria-label="Variable value"]');
    await evaluate(`document.querySelector('button[aria-label="Save variable"]').click()`);
    await until(`!document.querySelector('#agent-info')?.innerText.includes('missing')`, "the inspector no longer says missing");
    await evaluate(`document.querySelector('#agent-info button[aria-label="Close agent details"]').click()`);
    await until("!document.body.innerText.includes('missing required secrets')", "the agent opens once the value is set");

    const stored = JSON.parse(readFileSync(join(data, "secrets.json"), "utf8"));
    assert.equal(stored.k[NAME], VALUE, "kage holds the value");
    for (const file of filesUnder(project))
      assert.ok(!readFileSync(join(file.parentPath, file.name)).includes(VALUE), `the value is not written into the agent's folder (${file.name})`);

    const checked = async (command) => {
      const before = await evaluate("(document.querySelector('[aria-label=\"Transcript\"]')?.innerText ?? '').split('Checked.').length");
      script.push(command, undefined);
      await send("check the environment");
      await until(`(document.querySelector('[aria-label="Transcript"]')?.innerText ?? '').split('Checked.').length > ${before} && !document.querySelector('button[aria-label="Stop the run"]')`, "the run ends");
    };
    await checked(`printenv ${NAME} > got-token.txt; printenv KAGE_UNDECLARED > got-undeclared.txt; true`);
    assert.equal(readFileSync(join(project, "got-token.txt"), "utf8").trim(), VALUE, "the declared value reaches the command");
    assert.equal(readFileSync(join(project, "got-undeclared.txt"), "utf8"), "", "a variable nobody declared does not");
    assert.ok(!existsSync(join(project, ".state", NAME)));

    // The agent stays open while the route changes; its commands keep one proxy, kage's, which takes the route
    // as it is for each connection. `kage.test` resolves nowhere, so only the upstream proxy can answer for it.
    const upstream = createServer((_req, res) => res.end("via-upstream"));
    upstream.on("connect", (_req, socket) => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.emit("connection", socket);
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const fetched = async (name) => {
      await checked(`printenv HTTPS_PROXY > ${name}-proxy.txt; curl -s --max-time 20 http://kage.test/ > ${name}.txt; true`);
      return { proxy: readFileSync(join(project, `${name}-proxy.txt`), "utf8").trim(), answer: readFileSync(join(project, `${name}.txt`), "utf8") };
    };
    try {
      await evaluate(`window.kage.setNetwork({ mode: "off" })`);
      const before = await fetched("off");
      assert.match(before.proxy, /^http:\/\/127\.0\.0\.1:\d+$/, "commands are given kage's proxy");
      assert.doesNotMatch(before.answer, /via-upstream/, "Off goes direct");
      await evaluate(`window.kage.setNetwork({ mode: "manual", url: "http://127.0.0.1:${upstream.address().port}" })`);
      const manual = await fetched("manual");
      assert.equal(manual.proxy, before.proxy, "the variables a command starts with do not change");
      assert.equal(manual.answer, "via-upstream", "a proxy set while the agent is open carries its next connection");
      await evaluate(`window.kage.setNetwork({ mode: "off" })`);
      assert.doesNotMatch((await fetched("off-again")).answer, /via-upstream/, "and turning it off takes it away again");
    } finally {
      upstream.close();
    }
    console.log("Secrets passed: a required value blocks the open, is set in the window, stays out of the folder and reaches only the commands; a route that changes under an open agent carries its next connection.");
    app.quit();
  }
  const timeout = setTimeout(() => {
    console.error("Secrets check timed out");
    app.exit(1);
  }, 80000);
  run()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
      app.exit(1);
    })
    .finally(() => {
      clearTimeout(timeout);
      server.close();
    });
}
