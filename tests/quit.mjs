// Quitting with a run in progress, through the real window: "Quit anyway" records a stop and the app exits at once;
// the next launch finds the message canceled, not answered, and its tool not run again.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import electron from "electron";
import { chunk, isolated, openInstance, withoutCredentials, writeInstance } from "./harness.mjs";
import { open, sleep, windowDriver } from "./window.mjs";

const AGENT = "q";
// Longer than quitting may take and shorter than a leftover would be worth keeping; the number names it for `pgrep`.
const TOOL = "sleep 23";

const root = await isolated(import.meta.url, {
  name: "quit",
  program: {},
  timeout: 90000,
  async after(root) {
    const result = JSON.parse(readFileSync(join(root, "quit-result.json"), "utf8"));
    assert.equal(result.dialogs, 1, "the person was asked once");
    assert.equal(result.asked, "An agent is still working.");
    assert.ok(result.quitMs < 6000, `quitting did not wait for the tool to finish (${result.quitMs} ms)`);
    // `pgrep` exits 1 when nothing matches: a cancel that did not end the tool leaves it running after the app.
    assert.equal(spawnSync("pgrep", ["-f", TOOL]).status, 1, `the cancelled tool (${TOOL}) is not left running`);
    // Electron has exited: open the instance as the next launch would.
    process.env.FASTAGENT_OFFLINE = "1";
    const project = join(root, "project");
    process.env.KAGE_MOCK_MODEL_URL = "http://127.0.0.1:9/v1";
    const agent = await openInstance(project);
    try {
      const [session] = (await agent.sessions.list()).data;
      assert.ok(session, "the conversation was kept");
      const user = (await agent.sessions.entries(session.id)).data.find((entry) => entry.kind === "user");
      const message = await agent.messages.get({ sessionId: session.id, messageId: user.data.messageId });
      assert.equal(message.status, "canceled", "the run was stopped, not left to be answered");
      // Time for a message that would be picked up again to be.
      await sleep(3000);
      assert.equal((await agent.messages.get({ sessionId: session.id, messageId: user.data.messageId })).status, "canceled");
      assert.equal((await agent.sessions.get(session.id)).status, "idle");
      assert.equal(readFileSync(join(project, "ran.txt"), "utf8").trim().split("\n").length, 1, "the tool ran once");
      assert.equal(result.modelCalls, 1, "the model was asked once, before quitting");
    } finally {
      await agent.close();
    }
    console.log(`Quit passed: Quit anyway left in ${result.quitMs} ms; the next launch found the message canceled and nothing run again.`);
  },
});
if (root) {
  const { app, dialog } = electron;
  withoutCredentials(process.env);
  const data = join(root, "user-data");
  const project = join(root, "project");
  mkdirSync(data, { recursive: true });
  app.setPath("userData", data);

  let modelCalls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      modelCalls++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const command = `echo ran >> ran.txt; ${TOOL}`;
      res.write(chunk({ role: "assistant", content: "Working.", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }));
      res.write(chunk({}, "tool_calls"));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.KAGE_MOCK_MODEL_URL = `http://127.0.0.1:${server.address().port}/v1`;
  writeInstance(project, { model: "mock/mock" });
  writeFileSync(join(data, "agents.json"), JSON.stringify([{ id: AGENT, name: "Quit", dir: project, colour: 1 }]));

  const dialogs = [];
  dialog.showMessageBoxSync = (_window, options) => {
    dialogs.push((options ?? _window).message);
    return 0;
  };

  async function run() {
    const win = await open();
    const { until, send } = windowDriver(win, { timeout: 30000, poll: 50 });
    await send("long job");
    await until(`!!document.querySelector('button[aria-label="Stop the run"]') && /running/.test(document.querySelector('[aria-label="Transcript"]')?.innerText ?? '')`, "the run is working");
    for (let t = 0; t < 100 && !existsSync(join(project, "ran.txt")); t++) await sleep(50);
    assert.ok(existsSync(join(project, "ran.txt")), "the tool started");

    const began = Date.now();
    const quit = new Promise((resolve) => app.once("quit", resolve));
    app.quit();
    const outcome = await Promise.race([quit.then(() => "quit"), sleep(15000).then(() => "stuck")]);
    assert.equal(outcome, "quit", "the app quit after the answer");
    writeFileSync(
      join(root, "quit-result.json"),
      JSON.stringify({ dialogs: dialogs.length, asked: dialogs[0], quitMs: Date.now() - began, modelCalls }),
    );
  }
  const timeout = setTimeout(() => {
    console.error("Quit check timed out");
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
