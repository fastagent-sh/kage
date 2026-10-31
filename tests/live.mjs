// Opt-in (`DUANG_LIVE=1`): real providers, this machine's duang credential file, a few tokens. `auth.json` is a
// symlink, never a copy: a copied OAuth login breaks when either refreshes. Quit duang first: two locks, one file.
import assert from "node:assert/strict";
import { existsSync, symlinkSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import electron from "electron";
import { isolated } from "./harness.mjs";
import { open, windowDriver } from "./window.mjs";
import { assertLiveReply, selectLiveModels } from "./live-models.mjs";

const ASK = "Reply with exactly: OK";

if (!process.versions.electron && process.env.DUANG_LIVE !== "1") {
  console.log("Skipped: set DUANG_LIVE=1 to spend real model credits against the real credential file.");
  process.exit(0);
}
// The real HOME: the credential file this check links to is the developer's own.
const root = await isolated(import.meta.url, { name: "live", timeout: 300000, home: false });
if (root) {
  const { app } = electron;
  const data = join(root, "user-data");
  const dir = join(root, "agent");
  app.setPath("userData", data);

  let win;
  let evaluate;
  const call = (name, ...args) =>
    evaluate(`window.duang.${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`);
  /**
   * How the message `asked` ended and the assistant's own words, so a "success" with no answer cannot pass. A send
   * answers once FastAgent has recorded the message, so wait for its `user` entry and then for the message's end.
   */
  async function reply(session, asked) {
    const subscription = `live-${session}`;
    for (let t = 0; t < 600; t++) {
      const opened = await call("openSession", "live", session, subscription);
      await call("closeSession", subscription);
      const sent = opened.entries.findLast((entry) => entry.kind === "user");
      const said = sent?.data.content?.map((part) => part.text ?? "").join("");
      const { lastMessage } = opened;
      if (said === asked && lastMessage && !["queued", "running"].includes(lastMessage.status)) {
        const text = opened.entries
          .filter((entry) => entry.kind === "assistant")
          .map((entry) => entry.data.text ?? "")
          .join("")
          .trim();
        const { model } = opened.session;
        return { text, model: model && `${model.provider}/${model.modelId}`, status: lastMessage.status, error: lastMessage.error };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`the message "${asked}" did not end`);
  }

  async function run() {
    await mkdir(dir, { recursive: true });
    await mkdir(data, { recursive: true });
    await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
    await writeFile(join(data, "agents.json"), JSON.stringify([{ id: "live", name: "Live", dir, colour: 0 }]));
    // The app's own data directory, named explicitly: this process is "Electron", not "duang".
    const real = join(app.getPath("appData"), "duang", "auth.json");
    assert.ok(
      existsSync(real),
      `${real} does not exist. Connect the providers to check in duang (Settings → Model providers), or ` +
        `sign in with the CLI pointed at it: FASTAGENT_AUTH_PATH="${real}" fastagent login`,
    );
    const authFile = join(data, "auth.json");
    symlinkSync(real, authFile);

    win = await open();
    ({ evaluate } = windowDriver(win));

    const models = await call("listModels", "live");
    const before = await readFile(authFile, "utf8");
    const [defaultModel, other] = selectLiveModels(models, {
      first: process.env.DUANG_LIVE_OPENAI,
      second: process.env.DUANG_LIVE_OTHER,
    });
    console.log(`Credential file: ${authFile}\nUsing: ${defaultModel} + ${other}`);

    // 1. The agent's default runs with the credentials already on this machine. The first provider is the one
    // `openai/gpt-5.5` names where it exists, because a ChatGPT account may not run every listed model (#5).
    assert.deepEqual(await call("setModel", "live", defaultModel), { ok: true });
    const first = await call("createSession", "live");
    const defaultRun = await call("send", "live", first, ASK);
    assert.equal(defaultRun.ok, true, `${defaultModel} send was refused: ${defaultRun.error?.message}`);
    const answer = await reply(first, ASK);
    if (answer.status === "completed") {
      assertLiveReply(answer, defaultModel);
      console.log(`${defaultModel} reply: ${JSON.stringify(answer.text)}`);
    } else {
      // A quota or entitlement refusal still proves the token resolved; a credential fault must not pass as one.
      assert.equal(answer.status, "failed", `${defaultModel} message ended ${answer.status}`);
      assert.doesNotMatch(answer.error.message, /not configured|refresh|unauthor|invalid[_ ]api|401/i);
      console.log(`${defaultModel} credentials accepted, provider refused the run: ${answer.error.message}`);
    }

    // 2. A conversation moved to the other provider.
    const second = await call("createSession", "live");
    assert.deepEqual(await call("setModel", "live", other, second), { ok: true });
    assert.equal((await call("send", "live", second, ASK)).ok, true, `${other} conversation send`);
    const otherAnswer = await reply(second, ASK);
    assert.equal(otherAnswer.status, "completed", `${other} message ended ${otherAnswer.status}: ${otherAnswer.error?.message}`);

    // 3. Issue #5's reported case: the agent's default is the first provider again, and the conversation keeps
    // the model the other provider recorded, and still runs.
    assert.deepEqual(await call("setModel", "live", defaultModel), { ok: true });
    assert.equal((await call("openAgent", "live")).model, defaultModel, `agent default is ${defaultModel}`);
    assert.equal((await call("send", "live", second, "Reply with exactly: STILL OK")).ok, true, "history send");
    const history = await reply(second, "Reply with exactly: STILL OK");
    assert.equal(history.status, "completed", `history message ended ${history.status}: ${history.error?.message}`);
    assert.equal(history.model, other, `the historical conversation kept its own model (${other})`);
    assert.match(history.text, /STILL OK/i);
    console.log(`${other} history (${history.model}) reply: ${JSON.stringify(history.text)}`);

    // Refresh may legitimately rewrite tokens; it must stay a readable file with the same providers.
    const after = await readFile(authFile, "utf8");
    assert.deepEqual(Object.keys(JSON.parse(after)).sort(), Object.keys(JSON.parse(before)).sort());
    console.log(`Credential file ${after === before ? "unchanged" : "rewritten by OAuth refresh"}, providers intact.`);
    console.log(`Live check passed: ${defaultModel} as the agent's default, ${other} kept by its conversation, one credential file.`);
  }

  const timeout = setTimeout(() => {
    console.error("Live check timed out");
    app.exit(1);
  }, 280000);
  run()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      clearTimeout(timeout);
      if (win && !win.isDestroyed()) win.destroy();
      app.exit(process.exitCode ?? 0);
    });
}
