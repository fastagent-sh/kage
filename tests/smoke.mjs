import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { isolated, withoutCredentials, writeMockAgent } from "./harness.mjs";
import { open, windowDriver } from "./window.mjs";

const root = await isolated(import.meta.url, { name: "smoke", timeout: 150000 });
if (root) {
  const { app, BrowserWindow, Menu } = electron;
  async function run() {
    // Empty: duang scaffolds the agent into it, and FastAgent only scaffolds a folder with nothing in it.
    const workspace = join(root, "project");
    const data = join(root, "user-data");
    mkdirSync(join(data, "Shared Dictionary", "cache"), { recursive: true });
    app.setPath("userData", data);
    const configured = join(root, "configured");
    await Promise.all([
      mkdir(workspace),
      mkdir(configured, { recursive: true }),
      mkdir(join(root, ".pi", "agent"), { recursive: true }),
      mkdir(join(root, ".fastagent", ".secrets"), { recursive: true }),
    ]);
    // Isolate all credential stores before FastAgent is imported. Never use the developer's subscription.
    process.env.HOME = root;
    withoutCredentials(process.env);
    const codex = { type: "oauth", access: "synthetic-codex", refresh: "synthetic-refresh", expires: Date.now() + 3600000 };
    const stored = {
      openai: { type: "api_key", key: "smoke-key" },
      anthropic: { type: "oauth", access: "sk-ant-oat01-synthetic", refresh: "synthetic-refresh", expires: Date.now() + 3600000 },
      "openai-codex": codex,
    };
    // duang's own file, in its user data. Everything below reads and writes only this one.
    const selectedAuth = join(data, "auth.json");
    // Stores duang must never read. They hold only `openai-codex` (or a wrong key), so the `anthropic/...`
    // assertions below cannot pass from them.
    const globalAuth = join(root, ".fastagent", ".secrets", "auth.json");
    const decoy = JSON.stringify({ "openai-codex": codex });
    process.env.FASTAGENT_AUTH_PATH = join(root, "custom-auth.json");
    await writeFile(process.env.FASTAGENT_AUTH_PATH, decoy);
    await writeFile(globalAuth, decoy);
    await writeFile(join(root, ".fastagent", "auth.json"), decoy);
    await writeFile(join(root, ".pi", "agent", "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "wrong-store" } }));
    await writeFile(selectedAuth, JSON.stringify(stored));
    // A model of the agent's own, declared in its config: listed for this agent only, and accepted as its model.
    // Its endpoint is never reached.
    // Enough models with the real catalog's to pass the picker's 60-row cut-off, which says so.
    writeMockAgent(configured, 9, { provider: "local", modelId: "m1", extraModels: 40, defaultModel: "openai/gpt-4o-mini" });
    // A skill is what the agent's commands list, so the composer's `/` completion has something to find.
    await mkdir(join(configured, "skills", "demo"), { recursive: true });
    await writeFile(
      join(configured, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: A skill the completion list should offer.\n---\n\nSay demo.\n",
    );
    // More names than the list shows at once, so it scrolls and the keyboard cursor can leave the view.
    for (const suffix of "abcdefghi") {
      await mkdir(join(configured, "skills", `demo-${suffix}`), { recursive: true });
      await writeFile(
        join(configured, "skills", `demo-${suffix}`, "SKILL.md"),
        `---\nname: demo-${suffix}\ndescription: Another skill for the list to scroll past.\n---\n\nSay ${suffix}.\n`,
      );
    }
    await writeFile(
      join(data, "agents.json"),
      JSON.stringify([
        { id: "smoke", name: "Smoke", dir: workspace, colour: 0 },
        { id: "configured", name: "Configured", dir: configured, colour: 1 },
        // A directory that was registered and then moved or deleted: one broken agent, nothing else.
        { id: "gone", name: "Gone", dir: join(root, "moved-away"), colour: 2 },
      ]),
    );

    let requests = 0;
    let hold = false;
    let reject = false;
    let gate;
    let anthropicRequests = 0;
    let usageRequests = 0;
    let refuseCheck = false;
    const deepseekKeys = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url instanceof Request ? url.url : url);
      const headers = new Headers(options.headers ?? (url instanceof Request ? url.headers : undefined));
      if (target === "https://platform.claude.com/v1/oauth/token") {
        throw new Error("Synthetic OAuth refresh rejected");
      }
      if (target === "https://api.anthropic.com" && options.method === "HEAD") {
        if (refuseCheck)
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }),
          });
        return new Response(null, { status: 204 });
      }
      if (target === "https://api.anthropic.com/api/oauth/usage") {
        // The plan windows the header shows, read with the same login the conversation runs on.
        assert.equal(headers.get("authorization"), `Bearer ${stored.anthropic.access}`);
        usageRequests++;
        return Response.json({
          five_hour: { utilization: 4, resets_at: new Date(Date.now() + 3 * 3600_000).toISOString() },
          seven_day: { utilization: 18, resets_at: new Date(Date.now() + 2 * 86_400_000).toISOString() },
        });
      }
      if (target.startsWith("https://api.anthropic.com/v1/messages")) {
        assert.equal(headers.get("authorization"), `Bearer ${stored.anthropic.access}`);
        anthropicRequests++;
        const events = [
          { type: "message_start", message: { id: "msg_synthetic", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-5", stop_reason: null, usage: { input_tokens: 100000, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Anthropic smoke answer" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
          { type: "message_stop" },
        ];
        return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (target.startsWith("https://api.deepseek.com/")) {
        // The one-request check of a key being connected: 401 rejects it, a completion accepts it.
        deepseekKeys.push(headers.get("authorization"));
        if (headers.get("authorization") !== "Bearer sk-good")
          return Response.json({ error: { message: "Authentication Fails (invalid key)" } }, { status: 401 });
        const chunks = [
          { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }] },
          { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ];
        return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      assert.match(target, /^https:\/\/api\.openai\.com\/v1\/responses$/, "unexpected outbound request");
      assert.equal(headers.get("authorization"), "Bearer smoke-key");
      if (reject) return Response.json({ error: { message: "Synthetic key revoked" } }, { status: 401 });
      requests++;
      if (hold) {
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      if (gate) await gate;
      const tool = requests === 1;
      const item = tool
        ? {
            id: "fc_smoke",
            type: "function_call",
            call_id: "call_smoke",
            name: "read",
            arguments: JSON.stringify({ path: join(workspace, "hello.txt") }),
          }
        : {
            id: `msg_${requests}`,
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Smoke answer", annotations: [] }],
          };
      const events = [
        { type: "response.created", response: { id: `resp_${requests}` } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, ...(tool ? { arguments: "" } : { content: [] }) },
        },
        ...(tool ? [] : [{ type: "response.output_text.delta", output_index: 0, delta: "Smoke answer" }]),
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `resp_${requests}`,
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    };

    let win;
    const errors = [];
    const timeout = setTimeout(() => {
      console.error("Electron smoke timed out");
      app.exit(1);
    }, 60000);
    let until, evaluate, type, send, click;
    async function chooseModel(model) {
      await until("document.querySelector('dialog input') !== null", "model filter");
      await type(model, "dialog input");
      await until(`document.querySelector('dialog button[data-model="${model}"]')`, "filtered model");
      await evaluate(`document.querySelector('dialog button[data-model="${model}"]').click()`);
    }
    // A value written into code the page runs: JSON, with what could end or confuse a script escaped.
    const quoted = (value) =>
      JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const listOpen = "!!document.querySelector('#conversations:popover-open')";
    // A row is labelled by the newest message in its conversation, once the list has been read again.
    const rowListed = (text) =>
      `[...document.querySelectorAll('#conversations button[data-session]')].some((b) => b.textContent.includes(${quoted(text)}))`;
    async function clickListed(text) {
      await until(rowListed(text), `the list names a conversation by ${text}`);
      await click(text);
    }
    async function showConversations() {
      if (!(await evaluate(listOpen))) await evaluate(`document.querySelector('main > header button[title="Conversations"]').click()`);
      await until(listOpen, "the conversation list opens");
    }

    try {
      win = await open({
        attach: (window) =>
          window.webContents.on("console-message", (event) => {
            if (event.level === "error") errors.push(event.message);
          }),
      });
      ({ until, evaluate, type, send, click } = windowDriver(win, { timeout: 20000, poll: 25, dump: () => errors.join("\n") }));
      // Focus emulation, as Playwright does: without page focus Chromium fires no focus events, and stealing OS
      // focus is unreliable on macOS 14+.
      win.webContents.debugger.attach();
      await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      // GitHub's macOS runners have Reduce motion on; reduced motion is checked on its own below (#142).
      const motion = (value) =>
        win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value }] });
      await motion("no-preference");
      await until("document.body.innerText.includes('Create agent here')", "plain project setup");
      assert.ok(
        !(await evaluate("document.body.innerText")).includes("is not a fastagent agent"),
        "the scaffold offer must not be contradicted by the runtime's `run fastagent init` error",
      );
      // A stack leading with names Chromium does not resolve falls through to PingFang (hyphen 0.6em vs SF's 0.43).
      assert.ok(
        await evaluate(`(() => {
          const ruler = document.createElement('canvas').getContext('2d');
          ruler.font = '100px ' + getComputedStyle(document.body).fontFamily;
          return ruler.measureText('-').width < 50;
        })()`),
        "the chrome's Latin is drawn in the system font",
      );
      await click("Create agent here");
      await until("document.querySelector('dialog[open]') !== null", "first model picker opens automatically");
      await writeFile(join(workspace, "hello.txt"), "Hello from the workspace\n");
      await until(
        "document.querySelector('dialog').innerText.includes('Effort can be set once a model is chosen')",
        "an agent with no model has no levels to offer",
      );
      // Each model by the name it declares and its context window; the search matches the name too.
      await evaluate(`(() => {
        const input = document.querySelector('dialog input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'GPT-4o mini');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await until(
        "document.querySelector('dialog button[data-model=\"openai/gpt-4o-mini\"]')?.innerText.replace(/\\s+/g, ' ').trim() === 'GPT-4o mini 128K'",
        "a model row is its name and context window, found by its name",
      );
      await chooseModel("openai/gpt-4o-mini");
      await until("document.querySelector('dialog') === null", "first model picker closes");
      await until(
        "document.querySelector('textarea') && !document.querySelector('textarea').disabled",
        "first model unlocks composer",
      );
      // FastAgent's own scaffold, made in the folder itself, with the folder a git repository.
      for (const file of ["SYSTEM.md", "fastagent.config.ts", ".gitignore"]) await stat(join(workspace, file));
      await stat(join(workspace, ".git"));
      await send("Read hello.txt and answer.");
      await until(
        "document.querySelector('main').innerText.includes('Smoke answer') && !document.querySelector('main .bounce')",
        "stream settles",
      );
      // Chromium once skipped the Latin face when the Latin and Chinese faces declared different weights.
      await until(
        "[...document.fonts].some((f) => f.family === 'Prose' && f.unicodeRange.startsWith('U+0-FF') && f.style === 'normal' && f.status === 'loaded')",
        "the answer's Latin face loads",
      );
      // With only a 400 italic declared, `***x***` matched it and lost its weight.
      assert.deepEqual(
        await evaluate(`(async () => {
          const pick = async (text) =>
            (await document.fonts.load('italic 600 15px Prose', text)).map((f) => f.weight + ' ' + f.style);
          return [await pick('a'), await pick('中')];
        })()`),
        [["600 italic"], ["600 italic"]],
        "bold italic has its own Latin and Chinese faces",
      );
      // A tool that worked says nothing (§9): done means the result is in and the running badge gone.
      await until(
        `(() => {
          const card = document.querySelector('details details');
          return card && card.textContent.includes('Hello from the workspace') && !card.textContent.includes('running');
        })()`,
        "tool trace finishes",
      );
      // A card reaches 10px past its column; the disclosure must clip height only.
      assert.equal(
        await evaluate("getComputedStyle(document.querySelector('details'), '::details-content').overflowX"),
        "visible",
        "a disclosure clips its height, not its width",
      );
      // A drop shadow set as `box-shadow` would replace the `ring-1` hairline.
      assert.deepEqual(
        await evaluate(`['.composer-card', '.conversation-header'].map((selector) => /0px 0px 0px 1px/.test(getComputedStyle(document.querySelector(selector)).boxShadow))`),
        [true, true],
        "the composer and the header keep their hairline",
      );
      assert.equal(requests, 2, "a real read tool ran between two model requests");
      // The header floats: text scrolls beneath it and it lets the wheel through.
      assert.ok(
        await evaluate(`(() => {
          const header = document.querySelector('main > header').getBoundingClientRect();
          const transcript = document.querySelector('[aria-label="Transcript"]');
          const box = transcript.getBoundingClientRect();
          return (
            box.top < header.bottom &&
            box.top + parseFloat(getComputedStyle(transcript).paddingTop) >= header.bottom &&
            getComputedStyle(document.querySelector('main > header')).pointerEvents === 'none'
          );
        })()`),
        "the header floats over the transcript without covering its first turn or catching the wheel",
      );
      assert.ok(
        await evaluate(`(() => {
          const summary = document.querySelector('details details summary').textContent;
          return summary.includes('project/hello.txt') && !summary.includes('duang-smoke-');
        })()`),
        "a tool row names the file, not a machine-specific path",
      );
      assert.ok(
        await evaluate("document.querySelector('textarea').getBoundingClientRect().height <= 32"),
        "the empty composer starts compact and can grow with a draft",
      );
      // A settled answer ends with when it landed and a way to take it elsewhere.
      assert.ok(
        await evaluate(`(() => {
          const copy = document.querySelector('main button[aria-label="Copy message"]');
          // A character class, not \\d: a template literal eats the escape and the regex stops matching.
          return !!copy && /[0-9]{1,2}:[0-9]{2}/.test(copy.parentElement.textContent);
        })()`),
        "an answer is followed by its time and a copy control",
      );
      // A refused clipboard is said on the control, not swallowed (docs/ui.md §9b, the way on). The refusal is
      // real — an unfocused document rejects `writeText` — but whether this window is focused depends on the
      // machine, so it is stubbed here. Without a failure branch the control says nothing and this fails.
      const refusedCopy = await evaluate(`(async () => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: () => Promise.reject(new Error("Document is not focused.")) },
        });
        try {
          const copy = document.querySelector('main button[aria-label="Copy message"]');
          copy.click();
          for (let i = 0; i < 40; i++) {
            if (copy.parentElement.textContent.includes("could not copy")) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return copy.parentElement.textContent;
        } finally {
          delete navigator.clipboard;
        }
      })()`);
      assert.match(refusedCopy, /could not copy: Document is not focused\./, "a refused clipboard is said on the control");

      // The card now separates arguments from result, so read the whole card rather than its first block.
      const transcript = await evaluate("document.querySelector('details details').textContent");
      assert.match(transcript, /Hello from the workspace/);
      await click("openai/gpt-4o-mini");
      await until("document.querySelector('dialog button[aria-current=\"true\"]') !== null", "model picker reopens with the current model");
      assert.equal(
        await evaluate(`(() => {
          const first = document.querySelector('dialog button[data-model]');
          return first.getAttribute('aria-current') === 'true' ? first.dataset.model : undefined;
        })()`),
        "openai/gpt-4o-mini",
        "the current model appears first in the picker",
      );
      assert.ok(
        !(await evaluate("document.querySelector('dialog').innerText")).includes("Credentials"),
        "the credential file's path is not the picker's business",
      );
      assert.ok(
        (await evaluate("document.querySelector('dialog').innerText")).includes("This model has no effort setting"),
        "a model that does not reason offers no track",
      );
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await until("document.querySelector('dialog') === null", "Escape dismisses the picker");
      assert.equal(
        await evaluate("document.activeElement?.title"),
        "Model for this agent: openai/gpt-4o-mini",
        "picker restores focus to its trigger, whose tooltip names the whole model",
      );

      // Reopen through the actual UI and verify runtime-owned history, not the optimistic echo.
      await showConversations();
      await evaluate(`document.querySelector('button[title^="New conversation"]').focus()`);
      await until(`document.activeElement?.title?.startsWith('New conversation')`, "new conversation row focused");
      await evaluate(`document.activeElement.click()`);
      await until("document.body.innerText.includes('What should we work on')", "new conversation");
      assert.equal(await evaluate(listOpen), false, "choosing from the list puts it away");
      await until(
        `document.activeElement?.getAttribute('aria-label') === 'Message' && !document.activeElement.disabled`,
        "new conversation gives focus to the ready composer",
      );
      await showConversations();
      await click("Read hello.txt and answer.");
      await until("document.querySelector('main').innerText.includes('Smoke answer')", "durable history reopens");
      assert.equal((await evaluate("document.querySelector('main').innerText")).split("Smoke answer").length - 1, 1);

      // A turn that fails after taking its message is offered again, as a new turn, through the real runtime.
      reject = true;
      await send("Fail once, then answer.");
      await until("document.querySelector('main').innerText.includes('Synthetic key revoked')", "the failure is in the transcript");
      await until("!!document.querySelector('main button[title^=\"Send this message again\"]')", "Retry is offered under it");
      reject = false;
      await click("Retry");
      await until(
        "document.querySelector('main').innerText.split('Smoke answer').length - 1 === 2 && !document.querySelector('main button[title^=\"Send this message again\"]')",
        "Retry runs the message again and is gone once it answers",
      );
      assert.equal(
        (await evaluate("document.querySelector('main').innerText")).split("Fail once, then answer.").length - 1,
        2,
        "the failed turn and its retry both stay in the transcript",
      );
      // A conversation is listed by the newest thing said in it. Read back from FastAgent's history, the failure is still there under its turn.
      await evaluate("document.querySelector('button[title^=\"New conversation\"]').click()");
      await until("document.body.innerText.includes('What should we work on')", "left the conversation that failed once");
      await showConversations();
      await clickListed("Fail once, then answer.");
      await until("document.querySelector('main').innerText.includes('Synthetic key revoked')", "a failure reopens from history");

      hold = true;
      await send("Hold this turn so I can stop it.");
      await until("document.querySelector('button[aria-label=\"Stop the run\"]') !== null", "active stop control");
      // State and consequences in words, not only in colour.
      assert.match(
        await evaluate("document.querySelector('button[aria-label=\"Stop the run\"]').title"),
        /not undone/,
      );
      assert.match(await evaluate("document.querySelector('button[aria-label=\"Smoke\"]').title"), /\nWorking$/);
      assert.match(await evaluate("document.querySelector('aside').innerText"), /working/, "state is readable, not hovered");
      // The eyes are <defs> drawn through <use>; a selector that misses the copies freezes the face with no error.
      const smokeAvatar = `document.querySelector('button[aria-label="Smoke"] .avatar')`;
      await until(`!!${smokeAvatar}?.querySelector('svg .dbga-eye')`, "the default avatars are drawn");
      await until(`['thinking', 'tool', 'answering'].includes(${smokeAvatar}.dataset.face)`, "a working agent wears a working face");
      assert.ok(await evaluate(`${smokeAvatar}.classList.contains('ring-2')`), "and the presence ring");
      // Pixels, not computed styles: those are the original's, which can be right while the copies stand still.
      const face = await evaluate(`(() => { const r = ${smokeAvatar}.getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`);
      const frames = [];
      // Said if frames never differ: reduced motion (#142 on CI), the face, its animations and its position.
      const seen = [];
      for (let i = 0; i < 8; i++) {
        frames.push((await win.webContents.capturePage(face)).toBitmap());
        seen.push(
          await evaluate(`(() => {
            const a = ${smokeAvatar};
            const r = a.getBoundingClientRect();
            const running = document.getAnimations().filter((x) => a.contains(x.effect?.target) && x.playState === 'running').map((x) => x.animationName);
            const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced motion' : 'motion allowed';
            return reduced + ', ' + a.dataset.face + ' [' + running.join(' ') + '] @' + Math.floor(r.x) + ',' + Math.floor(r.y);
          })()`),
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.ok(
        frames.some((frame) => !frame.equals(frames[0])),
        `and the drawn face moves while it works: 8 identical frames of ${JSON.stringify(face)}, ${JSON.stringify(seen)}`,
      );
      // With reduced motion, nothing in the roster moves: the face keeps its pose and `working` its dot.
      await motion("reduce");
      assert.deepEqual(
        await evaluate(`document.getAnimations().filter((a) => a.effect?.target?.closest?.('aside') && a.playState === 'running').map((a) => a.animationName)`),
        [],
        "reduced motion stops every animation in the roster",
      );
      await motion("no-preference");
      // Not a Stop either, even in the task that opened the list, before React heard the popover's `toggle`.
      await evaluate(`(() => {
        document.querySelector('main > header button[title="Conversations"]').click();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(
        await evaluate("!!document.querySelector('button[aria-label=\"Stop the run\"]')"),
        "an Escape the instant the list opens does not stop the run",
      );
      await until(listOpen, "the list is open");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await until(`!${listOpen}`, "Escape closes the list over a running turn");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(await evaluate("!!document.querySelector('button[aria-label=\"Stop the run\"]')"), "and the run keeps going");
      await evaluate("document.querySelector('button[title^=\"New conversation\"]').click()");
      await until("document.body.innerText.includes('What should we work on')", "background run keeps going");
      await clickListed("Hold this turn so I can stop it.");
      await until("document.querySelector('button[aria-label=\"Stop the run\"]') !== null", "return to active run");
      await evaluate("document.querySelector('button[aria-label=\"Stop the run\"]').click()");
      await until("document.body.innerText.includes('run stopped')", "stopping is a settled transcript outcome");
      await until("document.querySelector('button[aria-label=\"Send\"]') !== null", "composer leaves running state");

      // A run finishing elsewhere leaves a filled mark in the sidebar and a dock count until looked at.
      hold = false;
      let release;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      await send("Answer while I look elsewhere.");
      await evaluate("document.querySelector('button[title^=\"New conversation\"]').click()");
      await until("document.body.innerText.includes('What should we work on')", "left the running conversation");
      release();
      gate = undefined;
      const unseenMark = "document.querySelector('aside [title$=\"while you were away\"]')";
      await until(`${unseenMark}?.textContent.startsWith('1')`, "an outcome nobody saw is counted on its agent's row");
      assert.equal(
        await evaluate(`document.querySelector('button[aria-label="Smoke"] .avatar').dataset.face`),
        "done",
        "and its avatar is pleased about it, over being the open one",
      );
      assert.ok(await evaluate(`document.querySelector('button[aria-label="Smoke"] .avatar svg').innerHTML.includes('id="eyes-happy')`), "with happy eyes");
      assert.equal(electron.app.getBadgeCount(), 1, "and counted on the dock");
      // The count sits on the first line of what the row quotes, under the time: not a line below a short quote.
      assert.deepEqual(
        await evaluate(`(() => {
          const mark = ${unseenMark};
          const quote = mark.parentElement.querySelector('span.font-prose');
          const line = parseFloat(getComputedStyle(quote).lineHeight);
          return [Math.round(mark.getBoundingClientRect().top - quote.getBoundingClientRect().top) < line];
        })()`),
        [true],
        "the unread count is level with the quote's first line, not a line away from it",
      );
      assert.equal(
        await evaluate("document.querySelector('main > header button[title=\"Conversations\"]').getAttribute('aria-label')"),
        "Conversations, 1 unseen",
        "the list button says there is something in it to look at",
      );
      // The message went into the conversation that was already open, so find the row by the mark
      // it is carrying rather than by a label.
      await showConversations();
      await evaluate(`(() => {
        const row = [...document.querySelectorAll('#conversations button[data-session]')].find((b) => b.textContent.endsWith('done'));
        if (!row) throw new Error('Missing the marked conversation row');
        row.click();
      })()`);
      await until(`${unseenMark} === null`, "looking at it spends the mark");
      assert.equal(electron.app.getBadgeCount(), 0, "and clears the dock");

      // Persisted registry and history survive reloading the renderer.
      win.webContents.reload();
      await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
      await until("document.querySelector('main').innerText.includes('Smoke answer')", "history after reload");
      hold = false;
      await evaluate("document.querySelector('button[aria-label=\"Configured\"]').click()");
      await until(
        "document.body.innerText.includes('What should we work on?') && !document.querySelector('textarea').disabled",
        "directory-configured model",
      );
      await send("Use the configured model with the selected credentials.");
      await until("document.querySelector('main').innerText.includes('Smoke answer') && !document.querySelector('main .bounce')", "configured model uses the same credential file");

      const models = await evaluate("window.duang.listModels('configured')");
      assert.ok(models.some((model) => model.spec === "anthropic/claude-sonnet-4-5"));
      // Another provider's default for the race and history checks below; pi's retired ChatGPT route is not offered.
      const otherModel = "openai/gpt-5.5";
      assert.ok(models.some((model) => model.spec === otherModel));
      assert.ok(!models.some(({ spec }) => spec.startsWith("openai-codex/")), "the retired route's models are not offered");
      assert.ok(models.some((model) => model.spec === "local/m1"), "the agent's own provider is pickable");
      assert.ok(!(await evaluate("window.duang.listModels('smoke')")).some((model) => model.spec === "local/m1"), "another agent's is not");
      const sessionSaying = (text) =>
        evaluate(`window.duang.openAgent('configured').then((r) => r.sessions.find((s) => s.preview?.includes(${quoted(text)}))?.session)`);
      const historical = await sessionSaying("Use the configured model");
      assert.ok(historical, "the conversation that ran on the configured model is listed, by what was said in it");
      // The conversation's last message ends in FastAgent, after a send has answered: read how it ended.
      const ended = async (agent, session) => {
        for (let t = 0; t < 200; t++) {
          const { lastMessage } = await evaluate(`window.duang.openSession(${JSON.stringify(agent)}, ${JSON.stringify(session)}, 'probe').then(async (r) => (await window.duang.closeSession('probe'), r))`);
          if (lastMessage && !["queued", "running"].includes(lastMessage.status)) return lastMessage;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("the message did not end");
      };
      // Replacing the runtime is main's business: no reload, the scroll stays, nothing said broke.
      await evaluate(`window.__transcript = document.querySelector('[aria-label="Transcript"]'); window.__scroll = window.__transcript.scrollTop;`);
      await click("openai/gpt-4o-mini");
      await until("document.querySelector('dialog[open]') !== null", "cross-provider model picker");
      await chooseModel("anthropic/claude-sonnet-4-5");
      await until("!document.querySelector('textarea').disabled && document.body.innerText.includes('anthropic/claude-sonnet-4-5')", "selected conversation changes provider");
      assert.ok(
        await evaluate(`document.querySelector('[aria-label="Transcript"]') === window.__transcript`),
        "a model change leaves the transcript standing: it is the same element, not one rebuilt",
      );
      assert.equal(await evaluate("window.__transcript.scrollTop"), await evaluate("window.__scroll"), "and where it was scrolled");
      assert.ok(
        !/Reconnect|runtime was rebuilt/.test(await evaluate("document.querySelector('main').innerText")),
        "and it does not say its subscription was cut",
      );
      await send("Use the Anthropic conversation model.");
      await until("document.querySelector('main').innerText.includes('Anthropic smoke answer') && !document.querySelector('main .bounce')", "synthetic Anthropic OAuth request");
      assert.equal(anthropicRequests, 1);
      // Effort is the conversation's own level.
      const chip = `document.querySelector('button[title^="Model for this agent"]')`;
      await evaluate(`${chip}.click()`);
      await until("document.querySelector('dialog [role=radiogroup][aria-label=Effort]')", "a conversation offers an effort track");
      // The list stops at 60 rows, and a provider past them shows no heading: it says there are more.
      await until("document.querySelectorAll('dialog button[data-model]').length > 0", "the models are listed");
      assert.match(await evaluate("document.querySelector('dialog').innerText"), /\d+ more: search to narrow the list/, "a cut-off list says so");
      const levels = await evaluate(`[...document.querySelectorAll('dialog [role=radio]')].map((stop) => stop.getAttribute('aria-label'))`);
      const sonnet = (await evaluate("window.duang.listModels('configured')")).find((m) => m.spec === "anthropic/claude-sonnet-4-5");
      assert.deepEqual(levels, sonnet.thinkingLevels.map((level) => ({ xhigh: "Extra high" })[level] ?? level[0].toUpperCase() + level.slice(1)), "the stops are the levels the model supports");
      assert.ok(levels.length > 1 && levels.includes("High"), `a reasoning model offers a track: ${levels}`);
      assert.match(await evaluate("document.querySelector('dialog').innerText"), /Agent default/, "a conversation that was not given a level follows the agent's");
      const unsupported = await evaluate(`window.duang.setThinking('configured', ${JSON.stringify(historical)}, 'max')`);
      assert.equal(unsupported.ok, sonnet.thinkingLevels.includes("max"), "a level the model lacks is refused, not clamped behind the person's back");
      const thinkingSession = historical;
      const levelOf = () => evaluate(`window.duang.readState('configured', ${JSON.stringify(thinkingSession)}).then((s) => s.thinkingLevel)`);
      await evaluate(`document.querySelector('dialog [role=radio][aria-label="High"]').click()`);
      await until(`${chip}.textContent.includes('High')`, "the chip names the level");
      await until(`document.querySelector('dialog [role=radio][aria-label="High"]').getAttribute('aria-checked') === 'true'`, "and so does the track");
      assert.equal(await levelOf(), "high", "FastAgent holds it on the conversation");
      // Arrows move focus and write nothing, Enter chooses.
      const target = levels[levels.indexOf("High") - 2];
      await evaluate(`document.querySelector('dialog [role=radio][aria-label="High"]').focus()`);
      for (let i = 0; i < 2; i++) {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Left" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Left" });
      }
      await until(`document.activeElement.getAttribute('aria-label') === ${JSON.stringify(target)}`, `two arrow presses move the focus to ${target}`);
      assert.equal(await levelOf(), "high", "moving along the track writes nothing");
      assert.ok(await evaluate(`${chip}.textContent.includes('High')`), "and the chip still names the conversation's level");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      await until(`${chip}.textContent.includes(${JSON.stringify(target)})`, `Enter chooses ${target}`);
      assert.equal(await levelOf(), target.toLowerCase(), "and FastAgent holds that one");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await until("document.querySelector('dialog') === null", "Escape closes the picker");
      // The header's edge is the context, always, even when a plan window is fuller (7d at 18% vs 10% here).
      await until("/context[\\s\\S]*50%/.test(document.querySelector('header').innerText)", "the header shows the conversation's context");
      // The table is hidden by opacity (so a keyboard can reach a link in it), which innerText does not see.
      const table = "getComputedStyle(document.querySelector('header [aria-label=Usage] .popover').parentElement).opacity";
      assert.equal(await evaluate(table), "0", "the plan's windows wait for a hover");
      assert.match(await evaluate("document.querySelector('header [aria-label=Usage]').textContent"), /5h[\s\S]*4%[\s\S]*7d[\s\S]*18%/, "the hover table lists every window");
      assert.equal(usageRequests, 1, "the run ending inside the gap reuses the answer instead of asking again");

      // A new conversation says `–`, and the plan's windows are still one hover away.
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, cancelable: true }))`);
      await until("document.body.innerText.includes('What should we work on?')", "a new conversation");
      await until(
        "/5h[\\s\\S]*4%[\\s\\S]*7d[\\s\\S]*18%/.test(document.querySelector('header [aria-label=Usage]')?.textContent ?? '')",
        "the plan's windows are one hover away in a conversation with no context yet",
      );
      assert.match(await evaluate("document.querySelector('header').innerText"), /context\s*–/, "and the context says it is not known yet");
      // Effort set before the first message lives on a conversation FastAgent already holds, listed as New conversation.
      const newRows = "[...document.querySelectorAll('#conversations button')].filter((b) => b.textContent.includes('New conversation')).length";
      await showConversations();
      const rowsBefore = await evaluate(newRows);
      await evaluate("document.getElementById('conversations').hidePopover()");
      await until(`${chip} && !${chip}.hasAttribute('aria-disabled')`, "the new conversation's model chip is ready");
      await evaluate(`${chip}.click()`);
      await until("document.querySelector('dialog [role=radio][aria-label=\"High\"]')", "a new conversation offers effort before its first message");
      await evaluate(`document.querySelector('dialog [role=radio][aria-label="High"]').click()`);
      await until(`${chip}.textContent.includes('High')`, "and takes it");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await until("document.querySelector('dialog') === null", "the picker closes");
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, cancelable: true }))`);
      await until("document.body.innerText.includes('What should we work on?')", "another new conversation");
      await showConversations();
      await until(`${newRows} === ${rowsBefore} && ${newRows} >= 1`, "the conversation left after setting its effort is still listed, as New conversation, and not made twice");
      await evaluate("document.getElementById('conversations').hidePopover()");
      await showConversations();
      await evaluate(`[...document.querySelectorAll('#conversations button')].find((b) => b.textContent.includes('Use the Anthropic conversation model')).click()`);
      await until("document.querySelector('main').innerText.includes('Anthropic smoke answer')", "back in the conversation with its history");

      assert.deepEqual(await evaluate("window.duang.setModel('configured', 'local/m1')"), { ok: true }, "setModel accepts it");
      assert.equal((await evaluate("window.duang.setModel('configured', 'local/nope')")).error.code, "model_unavailable");
      const racing = await evaluate(`(async () => {
        const change = window.duang.setModel('configured', ${JSON.stringify(otherModel)});
        const reads = [];
        for (let i = 0; i < 40; i++) {
          reads.push(window.duang.openAgent('configured'));
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return [await change, await Promise.all(reads)];
      })()`);
      assert.equal(racing[0].ok, true);
      assert.ok(
        racing[1].every((read) => read.ok),
        "a read during a settings change still answers",
      );
      win.webContents.reload();
      await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
      await until("document.querySelector('main').innerText.includes('Smoke answer')", "reload initial agent");
      // A crashed renderer is reloaded onto what it showed; the third crash in a minute asks, and opens a new conversation.
      const asked = [];
      const showMessageBox = electron.dialog.showMessageBox;
      electron.dialog.showMessageBox = async (_window, options) => {
        asked.push(options.message);
        return { response: 0 };
      };
      try {
        for (let crash = 1; crash <= 3; crash++) {
          const reloaded = new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
          win.webContents.forcefullyCrashRenderer();
          await reloaded;
          if (crash < 3) {
            assert.deepEqual(asked, [], `crash ${crash} reloads without asking`);
            await until("document.querySelector('main').innerText.includes('Smoke answer')", `crash ${crash}: reloaded onto its conversation`);
          }
        }
        assert.deepEqual(asked, ["duang's window keeps crashing."], "the third crash asks instead of reloading");
        await until("document.body.innerText.includes('What should we work on?')", "the way on is a new conversation");
        assert.ok(!(await evaluate("document.querySelector('main').innerText.includes('Smoke answer')")), "not the one it crashed on");
        assert.equal(await evaluate("window.location.hash"), "", "the fresh start is read once");
      } finally {
        electron.dialog.showMessageBox = showMessageBox;
      }
      // The historical conversation is one choice away, in the list: the fresh start did not remove it.
      await evaluate("document.querySelector('button[aria-label=\"Configured\"]').click()");
      await until("!document.querySelector('textarea').disabled", "the Configured agent is open");
      await showConversations();
      await evaluate(`[...document.querySelectorAll('#conversations button')].find((b) => b.textContent.includes('Use the Anthropic conversation model')).click()`);
      await until("document.body.innerText.includes('anthropic/claude-sonnet-4-5') && !document.querySelector('textarea').disabled", "history keeps its provider despite Codex default");
      assert.equal(await evaluate("window.duang.openAgent('configured').then(r => r.model)"), otherModel);
      await send("Continue the historical Anthropic conversation.");
      await until("document.querySelector('main').innerText.split('Anthropic smoke answer').length === 3 && !document.querySelector('main .bounce')", "mixed-provider history resolves its own credential");
      assert.equal(anthropicRequests, 2);

      // A missing historical provider fails without silently switching models; fixing the file needs no restart.
      await writeFile(selectedAuth, JSON.stringify({ openai: stored.openai }));
      const missing = await evaluate(`window.duang.send('configured', ${JSON.stringify(historical)}, 'Missing provider check')`);
      assert.equal(missing.ok, false);
      assert.equal(missing.error.code, "model_unavailable", "refused before anything is recorded, in duang's words rather than the CLI's advice");
      assert.match(missing.error.message, /^anthropic\/claude-sonnet-4-5 cannot run: .*Connect the provider/);
      assert.equal(anthropicRequests, 2);
      assert.ok(!(await evaluate("window.duang.listModels('configured')")).some(({ spec }) => spec.startsWith("anthropic/")));
      const expired = { ...stored, anthropic: { ...stored.anthropic, expires: 0 } };
      await writeFile(selectedAuth, JSON.stringify(expired));
      assert.ok((await evaluate("window.duang.listModels('configured')")).some((model) => model.spec === "anthropic/claude-sonnet-4-5"), "picker does not attempt OAuth refresh");
      // The send is recorded; the refresh that fails is the message's own end, which FastAgent keeps.
      assert.equal((await evaluate(`window.duang.send('configured', ${JSON.stringify(historical)}, 'Expired token check')`)).ok, true);
      const refreshFailure = await ended("configured", historical);
      assert.equal(refreshFailure.status, "failed");
      assert.match(refreshFailure.error.message, /Synthetic OAuth refresh rejected/);
      assert.deepEqual(JSON.parse(await readFile(selectedAuth, "utf8")), expired, "failed refresh preserves the credential");
      await writeFile(selectedAuth, "{invalid");
      assert.match(await evaluate("window.duang.listModels('configured').then(() => '', error => error.message)"), /corrupt/i);
      await writeFile(selectedAuth, JSON.stringify(stored));
      assert.ok((await evaluate("window.duang.listModels('configured')")).some((model) => model.spec === "anthropic/claude-sonnet-4-5"));
      const recovered = await evaluate(`window.duang.send('configured', ${JSON.stringify(historical)}, 'Retry with restored credentials')`);
      assert.equal(recovered.ok, true);
      for (let t = 0; t < 200 && anthropicRequests < 3; t++) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(anthropicRequests, 3);
      assert.equal((await ended("configured", historical)).status, "completed");
      assert.deepEqual(JSON.parse(await readFile(selectedAuth, "utf8")), stored, "valid tokens are not refreshed or copied");
      // `/` completion: the names come from the agent's definition, Escape dismisses the list, and
      // accepting one leaves the line in the composer instead of sending it.
      await evaluate("document.querySelector('textarea').focus()");
      await type("/");
      await until("document.body.innerText.includes('A skill the completion list should offer')", "command list");
      assert.ok(
        (await evaluate("document.body.innerText")).includes("/skill:demo"),
        "the list shows the spelling accepting it inserts, not a bare /demo",
      );
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await until(
        "!document.body.innerText.includes('A skill the completion list should offer')",
        "Escape dismisses the command list",
      );
      await type("/d");
      await until("document.body.innerText.includes('A skill the completion list should offer')", "list reopens");
      // ArrowUp from the first wraps to the last, which must be scrolled fully into view.
      const chosenInView = (which) => `(() => {
        const rows = [...document.querySelectorAll('.composer .popover button')];
        const chosen = document.querySelector('.composer .popover [data-chosen]');
        if (chosen !== rows.at(${which})) return false;
        const row = chosen.getBoundingClientRect();
        const box = document.querySelector('.composer .popover').getBoundingClientRect();
        return row.top >= box.top && row.bottom <= box.bottom;
      })()`;
      await evaluate(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))`);
      await until(chosenInView(-1), "the last row is chosen and scrolled fully into view");
      // A resting pointer the list scrolls under must not take the cursor from the keys; a moving one does.
      await evaluate(`document.querySelector('.composer .popover button').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(await evaluate(chosenInView(-1)), "a row entered by a resting pointer does not take the cursor");
      await evaluate(`document.querySelector('.composer .popover button').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementX: 4 }))`);
      await until(
        "document.querySelector('.composer .popover [data-chosen]') === document.querySelector('.composer .popover button')",
        "a pointer that moves does",
      );
      await evaluate(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))`);
      await until(chosenInView(-1), "and the keys take it back");
      await evaluate(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))`);
      await until(chosenInView(0), "and the first row again");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      await until("document.querySelector('textarea').value === '/skill:demo '", "Enter accepts the skill in the spelling pi runs, it does not send");
      await type("");

      await evaluate("document.querySelector('button[aria-label=\"Smoke\"]').click()");
      await until("document.querySelector('main').innerText.includes('Smoke answer')", "back to the scaffolded agent");
      // Each row quotes the newest output of the conversation it would open.
      await until(
        "document.getElementById('status-configured')?.innerText.includes('Anthropic smoke answer')",
        "another agent's row quotes its conversation's newest output",
      );
      assert.match(await evaluate("document.querySelector('main').innerText"), /Smoke answer/, "without opening it");
      // Its conversations are in the header's list instead, and Escape puts the list away.
      await showConversations();
      assert.ok(
        (await evaluate("document.querySelector('#conversations').innerText")).includes("Answer while I look elsewhere."),
        "the header's list holds the open agent's conversations",
      );
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await until(`!${listOpen}`, "Escape closes the list");
      await type("/");
      await until("document.body.innerText.includes('/skill:writing-great-skills')", "the scaffolded agent's own skill is offered");
      await type("");

      // A registered directory that no longer exists breaks only its own agent, and stays removable.
      await evaluate("document.querySelector('button[aria-label=\"Gone\"]').click()");
      await until("document.body.innerText.includes('moved-away')", "the missing directory is named");
      // Removal is offered by the panel, not the sidebar row.
      await until(
        "[...document.querySelectorAll('main button')].some((b) => b.textContent.trim() === 'Remove from duang')",
        "a directory that no longer exists stays removable from the panel that explains it",
      );
      assert.ok(
        await evaluate("document.querySelector('main').innerText.includes(\"This agent's folder is not there\") && ![...document.querySelectorAll('main button')].some((b) => b.textContent.trim() === 'Create agent here')"),
        "a folder that is not there is said so, and is not offered a scaffold",
      );
      // An agent's name is duang's label, so even a broken agent can be renamed; the directory is not.
      await evaluate(`document.querySelector('button[aria-label="Gone"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await until("document.querySelector('aside input[aria-label=\"Agent name\"]') !== null", "agent rename opens");
      await evaluate(`(() => {
        const input = document.querySelector('aside input[aria-label="Agent name"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Gone for good');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`);
      await until("document.querySelector('button[aria-label=\"Gone for good\"]') !== null", "the roster shows the new name");
      assert.equal(
        await evaluate(`document.querySelector('button[aria-label="Gone for good"] .avatar').dataset.face`),
        "broken",
        "an agent whose folder is not there cannot run, and wears the face that says so",
      );
      assert.equal(
        JSON.parse(await readFile(join(data, "agents.json"), "utf8")).find((row) => row.id === "gone").name,
        "Gone for good",
        "the name is kept in the registry",
      );
      await evaluate("document.querySelector('button[aria-label=\"Smoke\"]').click()");
      await until("document.querySelector('main').innerText.includes('Smoke answer')", "the other agents are unaffected");

      // The picker's own states: named for assistive technology, and honest when nothing matches.
      await click("openai/gpt-4o-mini");
      await until("document.querySelector('dialog[open]') !== null", "picker for its empty state");
      assert.equal(await evaluate("document.querySelector('dialog').getAttribute('aria-label')"), "Choose a model");
      // Opening the list is asking to type in it: showModal() would otherwise leave focus on Close.
      assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), "Filter models");
      await evaluate(`(() => {
        const input = document.querySelector('dialog input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'no-such-model');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await until("document.querySelector('dialog').innerText.includes('Nothing matches')", "no filter matches");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await until("document.querySelector('dialog') === null", "picker closes again");

      // One tab stop for the roster, arrows inside it (§11).
      const roster = () =>
        evaluate(`(() => {
          const rows = [...document.querySelectorAll('aside [aria-label="Agents"] button')];
          return { rows: rows.length, tabbable: rows.filter((b) => b.tabIndex === 0).length };
        })()`);
      const counted = await roster();
      assert.ok(counted.rows > 1, "there is more than one row to walk");
      assert.equal(counted.tabbable, 1, "the roster is one tab stop, not one per row");
      assert.equal(
        await evaluate(`[...document.querySelectorAll('aside > :not([aria-label="Agents"]) button')].find((b) => b.textContent.trim() === 'Settings')?.tabIndex`),
        0,
        "Settings, outside the roster, is its own tab stop",
      );

      // A real Tab: the point of a roving tabindex is that Tab can enter the roster at all.
      await evaluate("document.querySelector('aside button[aria-label=\"Add agent directory\"]').focus()");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
      win.webContents.sendInputEvent({ type: "char", keyCode: "Tab" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
      await until(
        "document.activeElement.closest('aside [aria-label=Agents]') !== null",
        "Tab enters the roster from outside it",
      );
      // The list clips, so it must pad by the focus ring's width plus offset.
      assert.deepEqual(
        await evaluate(`(() => {
          const list = document.querySelector('aside [aria-label=Agents]');
          const ring = getComputedStyle(document.activeElement);
          const reach = parseFloat(ring.outlineWidth) + parseFloat(ring.outlineOffset);
          const pad = getComputedStyle(list);
          return [reach > 0, parseFloat(pad.paddingTop) >= reach, parseFloat(pad.paddingBottom) >= reach];
        })()`),
        [true, true, true],
        "the roster leaves room for its focus ring above the first row and below the last",
      );

      // One key at a time: two in one tick would read state React has not re-rendered.
      const press = (key) =>
        evaluate(
          `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`,
        );
      await evaluate("document.querySelector('aside [aria-label=Agents] button[tabindex=\"0\"]').focus()");
      // The rename handed the focus back to its row, and the keyboard stays where it was last moved.
      assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), "Gone for good");
      await press("ArrowUp");
      await until("document.activeElement.getAttribute('aria-label') === 'Configured'", "Up reaches the agent above");
      await press("Home");
      await until("document.activeElement.getAttribute('aria-label') === 'Smoke'", "Home reaches the first");

      // A way back to the live turn: absent at the bottom, offered once the tail is not followed,
      // and gone again after it takes you back.
      const backToLatest = "document.querySelector('button[aria-label=\"Back to the latest\"]')";
      assert.equal(await evaluate(`${backToLatest} === null`), true, "nothing to offer while at the bottom");
      // Small enough for the short conversation to overflow.
      const size = win.getSize();
      win.setSize(800, 540);
      await until(
        "document.querySelector('aside').getBoundingClientRect().width <= 260",
        "the sidebar gives reading space back in a narrow window",
      );
      await until(
        `(() => { const el = document.querySelector('[aria-label="Transcript"]'); return el.scrollHeight > el.clientHeight + 40; })()`,
        "the transcript can scroll",
      );
      // Re-issued each poll: the tail-following effect can pull the view back in the same frame.
      const atTop = `(() => {
        const el = document.querySelector('[aria-label="Transcript"]');
        el.scrollTop = 0;
        return ${backToLatest} !== null;
      })()`;
      const atBottom = `(() => {
        const el = document.querySelector('[aria-label="Transcript"]');
        el.scrollTop = el.scrollHeight;
        return ${backToLatest} === null;
      })()`;
      // A resize makes it scrollable with no scroll event, so settle at the bottom first.
      await until(atBottom, "still nothing to offer at the bottom of a small window");
      await until(atTop, "scrolling up offers the way back");
      await evaluate(`${backToLatest}.click()`);
      await until(`${backToLatest} === null`, "and it is gone once the transcript is back at the bottom");
      assert.ok(
        await evaluate(`(() => {
          const el = document.querySelector('[aria-label="Transcript"]');
          return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        })()`),
        "the transcript is at the bottom again",
      );

      // A mutation observer sees every state the DOM passes through, which polling would miss.
      const watchForStartScreen = () =>
        evaluate(`(() => {
          window.__startScreen = false;
          window.__watch?.disconnect();
          window.__watch = new MutationObserver(() => {
            if (document.body.innerText.includes('What should we work on?')) window.__startScreen = true;
          });
          window.__watch.observe(document.body, { subtree: true, childList: true, characterData: true });
        })()`);
      const settledOnHistory = (what) =>
        until(
          `${reading} !== null && !document.body.innerText.includes('What should we work on?') && !document.querySelector('main .bounce')`,
          what,
        );
      const noStartScreen = async (what) => {
        assert.equal(await evaluate("window.__startScreen"), false, `${what} does not pass through the new-conversation page`);
        await evaluate("window.__watch.disconnect()");
      };

      // The place being read survives a click on the open conversation, Settings, and another agent and back.
      const reading = `document.querySelector('[aria-label="Transcript"]')`;
      const nearly = (want) => `${reading} !== null && Math.abs(${reading}.scrollTop - ${want}) <= 2 && ${backToLatest} !== null`;
      const scrollAway = async () => {
        // The person scrolls: a wheel event is what ends a view's holding of its place.
        await evaluate(`${reading}.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))`);
        await until(
          `(() => { const el = ${reading}; el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2); return ${backToLatest} !== null; })()`,
          "scrolled into the middle of the conversation",
        );
        return evaluate(`Math.round(${reading}.scrollTop)`);
      };
      const left = await scrollAway();
      assert.ok(left > 20, `there is a place to come back to: ${left}`);
      await evaluate(`window.__reading = ${reading}`);
      await showConversations();
      await evaluate(`document.querySelector('#conversations button[data-session][aria-current="page"]').click()`);
      await evaluate(`document.querySelector('#conversations').hidePopover()`);
      assert.equal(await evaluate(`${reading} === window.__reading`), true, "opening the open conversation rebuilds nothing");
      assert.equal(await evaluate(`Math.round(${reading}.scrollTop)`), left, "and moves nothing");

      const openAgent = await evaluate(`document.querySelector('aside [aria-label="Agents"] button[aria-current="true"]').getAttribute('aria-label')`);
      await evaluate(`[...document.querySelectorAll('aside button')].find((b) => b.textContent.trim() === 'Settings').click()`);
      await until("document.querySelector('#providers-heading') !== null || document.querySelector('[aria-label=\"Transcript\"]') === null", "Settings shows");
      await evaluate(`document.querySelector('button[aria-label=${JSON.stringify(openAgent)}]').click()`);
      await until(nearly(left), "after Settings the conversation is where it was left");
      const other = ["Smoke", "Configured"].find((name) => name !== openAgent);
      await watchForStartScreen();
      await evaluate(`document.querySelector('button[aria-label=${JSON.stringify(other)}]').click()`);
      await until(`document.querySelector('main').innerText.length > 0 && document.querySelector('button[aria-label=${JSON.stringify(other)}]').getAttribute('aria-current') === 'true'`, "the other agent is open");
      await settledOnHistory("the other agent's conversation opens");
      await evaluate(`document.querySelector('button[aria-label=${JSON.stringify(openAgent)}]').click()`);
      await until(nearly(left), "after another agent the conversation is where it was left");
      await noStartScreen("switching to another agent and back");
      // At the latest line it stays there, rather than landing short of it while the content grows.
      await evaluate(`${reading}.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true }))`);
      await until(atBottom, "back at the latest line");
      // Left before the scroll event fired: what the view reports as it goes is what is remembered.
      await scrollAway();
      await evaluate(`(() => {
        const el = ${reading};
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true }));
        el.scrollTop = el.scrollHeight;
        [...document.querySelectorAll('aside button')].find((b) => b.textContent.trim() === 'Settings').click();
      })()`);
      await evaluate(`document.querySelector('button[aria-label=${JSON.stringify(openAgent)}]').click()`);
      await until(
        `(() => { const el = ${reading}; return el && el.scrollHeight - el.scrollTop - el.clientHeight < 4 && ${backToLatest} === null; })()`,
        "a conversation left at its latest line comes back at it, once the content has grown",
      );
      // Late growth (a code block highlighted late) keeps a following view at the latest line.
      await evaluate(`(() => { const pad = document.createElement('div'); pad.id = 'grow-probe'; pad.style.height = '400px'; ${reading}.firstElementChild.append(pad); })()`);
      await until(
        `(() => { const el = ${reading}; return el.scrollHeight - el.scrollTop - el.clientHeight < 4; })()`,
        "a view following the latest line stays on it while its content grows",
      );
      await evaluate(`document.getElementById('grow-probe').remove()`);
      win.setSize(size[0], size[1]);

      // Whitespace is not a message, and the composer stops growing at eight lines.
      await type("   \n  ");
      // Nothing to send, so Send is disabled but reachable, carrying its reason.
      assert.deepEqual(
        await evaluate(`(() => {
          const send = document.querySelector('button[aria-label="Send"]');
          return { blocked: send.getAttribute('aria-disabled'), why: send.title, reachable: send.disabled === false };
        })()`),
        { blocked: "true", why: "Nothing to send yet", reachable: true },
      );
      await type(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
      assert.ok(
        await evaluate(`(() => {
          const input = document.querySelector('textarea');
          const lines = parseFloat(getComputedStyle(input).lineHeight);
          return input.clientHeight <= lines * 8 + 2 && input.scrollHeight > input.clientHeight;
        })()`),
        "the composer scrolls instead of growing past eight lines",
      );
      // The model chip has a row of its own under a draft of several lines, and sits beside a single one.
      const chipBelow = `(() => {
        const text = document.querySelector('textarea').getBoundingClientRect();
        const chip = document.querySelector('button[title^="Model for this agent"]').getBoundingClientRect();
        return chip.top >= text.bottom;
      })()`;
      assert.ok(await evaluate(chipBelow), "a draft of several lines gives the model chip a row of its own");
      await type("one line");
      assert.ok(!(await evaluate(chipBelow)), "and a single line keeps it beside the text");
      await type("");
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, cancelable: true }))`);
      await until("document.body.innerText.includes('What should we work on?')", "⌘N starts a conversation");
      await until(
        `document.activeElement?.getAttribute('aria-label') === 'Message' && !document.activeElement.disabled`,
        "⌘N focuses the new conversation's composer",
      );

      // Off and Manual apply at once; an invalid URL is refused with its reason; an unreadable file is reported.
      const settingsFile = join(data, "settings.json");
      const fill = (label, value) =>
        evaluate(`(() => {
          const input = document.querySelector('input[aria-label=${JSON.stringify(label)}]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
      const choose = (label) =>
        evaluate(`[...document.querySelectorAll('[role=radio]')].find((r) => r.textContent.trim().startsWith(${JSON.stringify(label)})).click()`);
      // The App menu owns Settings… (⌘,); clicking the item is what the shortcut does.
      const settingsItem = Menu.getApplicationMenu().getMenuItemById("settings");
      assert.equal(settingsItem.accelerator, "Command+,");
      assert.ok(Menu.getApplicationMenu().items.some((item) => item.role === "editmenu"), "copy and paste keep their menu");
      settingsItem.click();
      // The chosen row checks its own connection on arrival; there is no button to find first.
      await until("document.querySelector('#network-heading') && /connected · \\d+ ms/.test(document.body.innerText)", "Settings… opens Settings and checks the route");
      assert.ok(await evaluate(`!!document.querySelector('button[aria-label="Configured"]')`), "the sidebar stays in view");
      assert.deepEqual(
        await evaluate(`[...document.querySelectorAll('aside [aria-current]')].map((el) => el.textContent.trim())`),
        ["Settings"],
        "while Settings shows, its row is the one selection mark",
      );
      settingsItem.click();
      assert.ok(await evaluate("!!document.querySelector('#network-heading')"), "asking again keeps Settings open");
      await choose("Off");
      await until("document.querySelector('[data-source=off] .font-mono')?.textContent === 'Direct' && /connected · \\d+ ms/.test(document.querySelector('[data-source=off]').textContent)", "Off applies at once and is checked");
      assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")).network, { mode: "off" });
      assert.equal(await evaluate(`document.querySelector('[role=radio][aria-checked=true]').textContent.trim().split('Direct')[0]`), "Off");
      // Manual with nothing saved shows its form and applies nothing until the proxy is complete.
      await choose("Manual");
      await until("document.querySelector('input[aria-label=Server]')", "the manual form");
      await click("Use this proxy");
      await until("document.body.innerText.includes('Server is required')", "an empty server is refused");
      await fill("Server", "127.0.0.1");
      await fill("Port", "70000");
      await click("Use this proxy");
      await until("document.body.innerText.includes('Port is a number from 1 to 65535')", "an impossible port is refused");
      assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")).network, { mode: "off" }, "a refused proxy is not saved");
      await choose("SOCKS5");
      await choose("HTTP");
      await fill("Port", "9");
      refuseCheck = true;
      await click("Use this proxy");
      await until("document.querySelector('[data-source=manual] .font-mono')?.textContent === 'http://127.0.0.1:9'", "Manual applies");
      // The cause's code is its own field from main; the whole sentence is the hover.
      await until("/unreachable \\(ECONNREFUSED\\)/.test(document.querySelector('[data-source=manual]').textContent)", "an unanswered check is unreachable, with its code");
      assert.match(
        await evaluate("document.querySelector('[data-source=manual] .text-danger').title"),
        /^api\.anthropic\.com via http:\/\/127\.0\.0\.1:9: ECONNREFUSED: connect ECONNREFUSED/,
      );
      refuseCheck = false;
      assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")).network, { mode: "manual", url: "http://127.0.0.1:9" });
      // A scheme's default port is saved and read back, not dropped to an empty field.
      await fill("Port", "80");
      await click("Use this proxy");
      await until("document.querySelector('[data-source=manual] .font-mono')?.textContent === 'http://127.0.0.1:80'", "port 80 applies");
      assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")).network, { mode: "manual", url: "http://127.0.0.1:80" });
      await evaluate(`document.querySelector('button[aria-label="Close settings"]').click()`);
      settingsItem.click();
      await until("document.querySelector('input[aria-label=Port]')?.value === '80'", "the reopened form shows port 80");
      await choose("Automatic");
      await until("!!document.querySelector('[data-source=system]')", "Automatic follows the system");
      assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")).network, { mode: "automatic" });
      // Two choices in one tick are applied in order: the file, Chromium and the page end on the second.
      await evaluate(`(() => {
        const rows = [...document.querySelectorAll('[role=radio]')];
        rows.find((r) => r.textContent.trim().startsWith('Off')).click();
        rows.find((r) => r.textContent.trim().startsWith('Automatic')).click();
      })()`);
      // The clicks return before either change lands, so wait for the file to stop changing.
      for (let last = -1, now = (await stat(settingsFile)).mtimeMs; now !== last; ) {
        last = now;
        await new Promise((resolve) => setTimeout(resolve, 500));
        now = (await stat(settingsFile)).mtimeMs;
      }
      assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")).network, { mode: "automatic" });
      assert.equal((await evaluate("window.duang.getRoute()")).source, "system", "Chromium ended on the second choice too");
      await until("document.querySelector('[data-source=system]')?.textContent.includes('connected')", "the page ends on the second choice");
      // Enter on the refresh control checks again; it does not re-apply (rewrite) the choice.
      const written = (await stat(settingsFile)).mtimeMs;
      await evaluate(`document.querySelector('button[aria-label="Check the connection again"]').focus()`);
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      await until("/connected · \\d+ ms/.test(document.body.innerText)", "the check runs again");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal((await stat(settingsFile)).mtimeMs, written, "Enter on refresh did not re-apply the setting");
      // One tab stop per choice group, on the checked row; the arrows move the choice and wrap.
      assert.deepEqual(
        await evaluate(`[...document.querySelectorAll('[role=radiogroup]')].map((g) => g.querySelectorAll('[role=radio][tabindex="0"]').length)`),
        [1, 1],
        "the Proxy group and the Avatar style group are one tab stop each",
      );
      const key = (keyCode) => {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode });
      };
      await evaluate(`document.querySelector('[role=radio][aria-checked=true]').focus()`);
      key("Up");
      await until("!!document.querySelector('[data-source=off]')", "ArrowUp from the first row wraps to Off and chooses it");
      key("Down");
      await until("!!document.querySelector('[data-source=system]') && document.activeElement?.textContent.trim().startsWith('Automatic')", "ArrowDown wraps back to Automatic");
      // An avatar style chosen here is saved and redraws every avatar at once, leaving the network alone.
      const chooseStyle = (label) =>
        evaluate(`[...document.querySelectorAll('[role=radiogroup][aria-label="Avatar style"] [role=radio]')].find((row) => row.textContent.startsWith(${JSON.stringify(label)})).click()`);
      await chooseStyle("Initials");
      await until(`!document.querySelector('aside .avatar svg') && document.querySelector('aside .avatar').textContent.trim() !== ''`, "the roster is redrawn in initials");
      // Initials are the one style drawn in a font of its own; it is only asked for once something uses it.
      await until("[...document.fonts].some((f) => f.family === 'Avatar' && f.status === 'loaded')", "the initials' face loads");
      // The roster changes once the file is written (store.setAvatar), so the file already says so.
      assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), { network: { mode: "automatic" }, avatar: "initials" });
      await chooseStyle("Gaze");
      await until(`!!document.querySelector('aside .avatar svg .dbga-eye')`, "and back in Gaze");
      await writeFile(settingsFile, "{broken");
      await evaluate(`document.querySelector('button[aria-label="Close settings"]').click()`);
      await until("!document.querySelector('#network-heading')", "the close control leaves Settings");
      await click("Settings");
      await until("document.body.innerText.includes('settings.json') && document.body.innerText.includes('Reveal in Finder')", "an unreadable settings file is reported");
      assert.ok(!(await evaluate("!!document.querySelector('#network-heading')")), "a broken file is not shown as the defaults");
      await writeFile(settingsFile, JSON.stringify({ network: { mode: "automatic" } }));
      await click("Retry");
      await until("document.querySelector('#network-heading')", "Retry reads the fixed file");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await until("!document.querySelector('#network-heading') && document.querySelector('textarea')", "Escape leaves Settings");

      // A key connected in its row (rejected once, fixed, accepted) and disconnected; only duang's file changes.
      const escape = () => {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      };
      const providersListed = "document.querySelector('#providers-heading') && document.querySelector('#providers-add-heading')";
      const connectedRow = (id) => `document.querySelector('#providers-heading ~ div [data-provider="${id}"]')`;
      const addRow = (id) => `document.querySelector('#providers-add-heading ~ div [data-provider="${id}"]')`;
      const openSettings = async () => {
        await click("Settings");
        await until(providersListed, "Settings lists the providers");
      };
      const fromPicker = async () => {
        // With nothing connected, the picker's one way forward is to connect a provider.
        await writeFile(selectedAuth, "{}");
        await evaluate(`document.querySelector('button[title^="Model for this agent"]').click()`);
        await until("[...document.querySelectorAll('dialog button')].some((b) => b.textContent.trim() === 'Connect a provider')", "the empty picker offers Connect a provider");
        assert.match(await evaluate("document.querySelector('dialog').innerText"), /No model is available/, "it says what it sees, not why");
        await evaluate(`[...document.querySelectorAll('dialog button')].find((b) => b.textContent.trim() === 'Connect a provider').click()`);
        await until(providersListed, "Connect a provider opens Settings");
      };
      const pickKey = async (id, query) => {
        await evaluate(`(() => {
          const input = document.querySelector('input[aria-label="Filter providers"]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await until(`${addRow(id)}?.querySelector('button[aria-expanded="false"]')`, `${id} is offered, closed: no flow left over`);
        await evaluate(`${addRow(id)}.querySelector('button[aria-expanded]').click()`);
        await until(`[...${addRow(id)}.querySelectorAll('button')].some((b) => b.textContent.startsWith('API key'))`, `${id}'s ways`);
        await evaluate(`[...${addRow(id)}.querySelectorAll('button')].find((b) => b.textContent.startsWith('API key')).click()`);
        await until(`${addRow(id)}?.querySelector('#provider-key:not(:disabled)')`, `${id}'s key field`);
      };
      const answer = async (value) => {
        await until("document.querySelector('#provider-key:not(:disabled)')", "the key field");
        await evaluate(`(() => {
          const input = document.querySelector('#provider-key');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.form.requestSubmit();
        })()`);
      };
      const landed = async (what) => {
        await until(`${connectedRow("deepseek")}?.innerText.includes('connected')`, what);
        assert.equal(await evaluate("!!document.querySelector('#provider-key')"), false, "the row it came from closed");
      };
      const chooseFromMenu = (label) => {
        const build = Menu.buildFromTemplate;
        Menu.buildFromTemplate = (template) => {
          Menu.buildFromTemplate = build;
          const item = template.find((entry) => entry.label === label);
          assert.ok(item, `the menu offers ${label}`);
          return { popup: () => item.click() };
        };
      };
      const disconnectDeepSeek = async (what) => {
        chooseFromMenu("Disconnect");
        await evaluate(`${connectedRow("deepseek")}.querySelector('button[aria-label="Actions for DeepSeek"]').click()`);
        await until(`document.querySelector('[role=alertdialog][aria-label="Disconnect DeepSeek"]')`, "Disconnect asks in the row");
        await evaluate(`[...document.querySelectorAll('[role=alertdialog] button')].find((b) => b.textContent.trim() === 'Disconnect').click()`);
        await until(`!${connectedRow("deepseek")}`, what);
      };

      await openSettings();
      assert.ok(await evaluate("document.body.innerText.includes('Anthropic')"), "listed by pi's names");
      assert.ok(
        await evaluate("!document.body.innerText.includes('OpenAI Codex')"),
        "pi's retired ChatGPT route is not listed, though duang's file still holds a login for it",
      );
      assert.equal(await evaluate("!!document.querySelector('dialog')"), false, "Settings reached from the sidebar opens no dialog");

      // A reload leaves nobody to answer the sign-in: it must end, or every later connect is refused.
      await pickKey("deepseek", "deep");
      const reloadedForSignIn = new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
      win.webContents.reload();
      await reloadedForSignIn;
      await until("!!document.querySelector('textarea')", "the reloaded window");
      await openSettings();
      await pickKey("deepseek", "deep");
      // ⌘N leaves Settings: the sign-in ends with it.
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, cancelable: true }))`);
      await until("!document.querySelector('#providers-heading')", "⌘N leaves Settings");
      await openSettings();
      await pickKey("deepseek", "deep");
      // Another row while one runs switches, ending the first; the race with main is the store's test.
      await pickKey("xai", "xai");
      assert.equal(
        await evaluate(`[...document.querySelectorAll('#provider-key')].map((input) => input.closest('[data-provider]').dataset.provider).join()`),
        "xai",
        "one sign-in on screen: the first row closed",
      );
      await pickKey("deepseek", "deep");

      await answer("sk-bad");
      await until(
        `${addRow("deepseek")}?.innerText.includes("didn't accept this key") && ${addRow("deepseek")}.textContent.includes('Authentication Fails') && document.querySelector('#provider-key:not(:disabled)')`,
        "a rejected key is asked for again, with the provider's reason",
      );
      assert.equal(await evaluate("document.querySelector('#provider-key').value"), "sk-bad", "kept, to be fixed in place");
      await answer("sk-good");
      await landed("the checked key is connected, and listed on Settings: this visit did not start at the picker");
      assert.deepEqual(deepseekKeys, ["Bearer sk-bad", "Bearer sk-good"], "each key was checked once, with the provider itself");
      let saved = JSON.parse(await readFile(selectedAuth, "utf8"));
      assert.deepEqual(saved.deepseek, { type: "api_key", key: "sk-good" }, "written to duang's own file");
      assert.equal(JSON.parse(await readFile(globalAuth, "utf8")).deepseek, undefined, "never to the CLI's");
      await disconnectDeepSeek("a disconnected provider leaves the list");
      saved = JSON.parse(await readFile(selectedAuth, "utf8"));
      assert.equal(saved.deepseek, undefined);
      assert.ok(saved.anthropic && saved.openai, "disconnecting one provider keeps the others");
      escape();
      await until("!document.querySelector('#providers-heading')", "Escape leaves Settings");

      // Reached from the picker but left by Escape: no trip back to the picker after connecting.
      await fromPicker();
      escape();
      await until("!document.querySelector('#providers-heading')", "Escape leaves Settings");
      await openSettings();
      await pickKey("deepseek", "deep");
      await answer("sk-good");
      await landed("a visit that did not start at the picker stays on Settings");
      await disconnectDeepSeek("disconnected again");
      escape();
      await until("!document.querySelector('#providers-heading')", "Escape leaves Settings");

      // Connected from the picker: back to the picker, with the new provider's models in it.
      await fromPicker();
      await pickKey("deepseek", "deep");
      await answer("sk-good");
      await until(
        "!document.querySelector('#providers-heading') && document.querySelector('dialog[aria-label=\"Choose a model\"] button[data-model^=\"deepseek/\"]')",
        "a connection started at the picker returns to it, listing the new models",
      );
      escape();
      await until("!document.querySelector('dialog')", "Escape closes the picker");
      // What the empty picker needed is put back, beside the provider it just connected.
      await writeFile(selectedAuth, JSON.stringify({ ...stored, ...JSON.parse(await readFile(selectedAuth, "utf8")) }));

      // A SOCKS4 PAC route is shown, not fatal: a send still goes out, agent commands get no proxy.
      await electron.session.defaultSession.setProxy({
        mode: "pac_script",
        pacScript: `data:application/x-ns-proxy-autoconfig,${encodeURIComponent('function FindProxyForURL() { return "SOCKS 127.0.0.1:1080"; }')}`,
      });
      assert.equal(await electron.session.defaultSession.resolveProxy("https://github.com"), "SOCKS 127.0.0.1:1080");
      const answers = () => evaluate("document.querySelector('main').innerText.split('Smoke answer').length");
      const before = await answers();
      await send("Send through a SOCKS4 PAC answer.");
      await until(`document.querySelector('main').innerText.split('Smoke answer').length > ${before} && !document.querySelector('main .bounce')`, "a send is not stopped by the commands' route");
      settingsItem.click();
      await until(
        "document.body.innerText.includes('unsupported proxy route') && document.body.innerText.includes('Agent commands get no proxy: Unsupported proxy route \"SOCKS 127.0.0.1:1080\"')",
        "both unusable routes are shown, and the settings file is not blamed",
      );
      assert.ok(!(await evaluate("document.body.innerText.includes('Fix or remove the file')")));
      await choose("Automatic");
      await until("!!document.querySelector('[data-source=system]') && !document.body.innerText.includes('Agent commands get no proxy')", "choosing again recovers");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await until("!document.querySelector('#network-heading')", "Escape leaves Settings again");

      // An unreadable registry must read as a failure, not as a fresh install with no agents.
      const registry = join(data, "agents.json");
      const savedRegistry = await readFile(registry, "utf8");
      await writeFile(registry, "[{\"id\"");
      win.webContents.reload();
      await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
      await until("document.body.innerText.includes('agents.json')", "registry failure is reported");
      const registryFailure = await evaluate("document.body.innerText");
      assert.ok(!registryFailure.includes("Add an agent directory"), "a corrupt registry is not an empty one");
      assert.ok(registryFailure.includes("Reveal agents.json"), "the person is shown where to fix it");
      await writeFile(registry, savedRegistry);
      await click("Retry");
      await until("document.querySelector('main').innerText.includes('Smoke answer')", "Retry recovers the registry");
      assert.equal(await readFile(registry, "utf8"), savedRegistry, "a failed read never rewrites the registry");
      // A default on the retired ChatGPT route opens; a send on it is refused with the code that opens the picker.
      await writeFile(
        registry,
        JSON.stringify([...JSON.parse(savedRegistry), { id: "legacy", name: "Legacy", dir: join(root, "configured"), model: "openai-codex/gpt-5.5", colour: 4 }]),
      );
      const legacy = await evaluate("window.duang.openAgent('legacy')");
      assert.equal(legacy.ok, true, legacy.message);
      assert.equal(legacy.model, "openai-codex/gpt-5.5", "the default is the one the registry names");
      const legacySend = await evaluate("window.duang.createSession('legacy').then((session) => window.duang.send('legacy', session, 'hello'))");
      assert.equal(legacySend.ok === false && legacySend.error.code, "model_unavailable", "a send on it asks for another model");
      // Removing an agent deletes duang's instance of it, once released: nothing could reach its conversations again.
      const instance = (id) => stat(join(data, "instances", id)).then(() => true, () => false);
      assert.equal(await instance("legacy"), true, "the opened agent has an instance");
      assert.deepEqual(await evaluate("window.duang.removeAgent('legacy')"), { ok: true });
      assert.equal(await instance("legacy"), false, "removing it deletes the instance, conversations included");
      assert.equal(await instance("smoke"), true, "and no other agent's");
      // A default pi does not know: the agent opens on its own model and the picker says the default is gone.
      await writeFile(
        registry,
        JSON.stringify([...JSON.parse(savedRegistry), { id: "stale", name: "Stale", dir: join(root, "configured"), model: "local/gone", colour: 5 }]),
      );
      win.webContents.reload();
      await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
      await until(`!!document.querySelector('button[aria-label="Stale"]')`, "the agent with a gone default is listed");
      await evaluate(`document.querySelector('button[aria-label="Stale"]').click()`);
      await until(
        "document.querySelector('dialog[open]')?.innerText.includes('local/gone is no longer available')",
        "the agent opens with the picker saying its default is gone",
      );
      assert.ok(!(await evaluate("document.body.innerText.includes('could not be loaded')")), "the agent is not broken");
      await chooseModel("local/m1");
      await until("!document.querySelector('dialog')", "choosing a model closes the picker");
      await until(`!!document.querySelector('main button[title="Model for this agent: local/m1"]')`, "the conversation runs on it");
      assert.equal(
        JSON.parse(await readFile(registry, "utf8")).find((row) => row.id === "stale").model,
        "local/m1",
        "the model chosen is the agent's default now",
      );
      await writeFile(registry, savedRegistry);
      win.webContents.reload();
      await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
      await until("document.querySelector('main').innerText.includes('Smoke answer')", "back on the agent the checks below use");

      // A long name stays inside the header with a tooltip; the conversation's title is not there.
      const longName = "An agent with a deliberately long descriptive name for this workspace";
      await evaluate(`document.querySelector('button[aria-label="Smoke"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await until("document.querySelector('aside input[aria-label=\"Agent name\"]')", "agent rename opens");
      await evaluate(`(() => {
        const input = document.querySelector('aside input[aria-label="Agent name"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(longName)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`);
      const headerName = `(() => {
        const line = document.querySelector('main > header .drag');
        const name = line.firstElementChild;
        const folder = document.querySelector('main > header button[title^="/"]');
        return {
          width: name.getBoundingClientRect().width,
          available: line.clientWidth,
          title: name.title,
          lines: line.childElementCount,
          folder: folder?.title,
          text: document.querySelector('main > header').innerText,
        };
      })()`;
      await until(`document.querySelector('main > header .drag > div')?.textContent === ${JSON.stringify(longName)}`, "renamed agent in header");
      const named = await evaluate(headerName);
      assert.equal(named.lines, 1, "the name alone in the drag handle");
      assert.ok(named.width <= named.available + 1, "the name stays inside the header");
      assert.equal(named.title, longName, "with the whole of it as a tooltip");
      assert.ok(named.folder?.startsWith("/"), "and the folder under it, a button that opens it");
      // Both routes open the folder of the agent they are on, not the open one's. Shell and menu are stubbed.
      const revealed = [];
      const showItemInFolder = electron.shell.showItemInFolder;
      const popup = electron.Menu.prototype.popup;
      electron.shell.showItemInFolder = (path) => void revealed.push(path);
      electron.Menu.prototype.popup = function () {
        this.items.find((item) => item.label === "Reveal in Finder").click();
      };
      try {
        await evaluate(`document.querySelector('main > header button[title^="/"]').click()`);
        await until("true", "the header's folder button is pressed");
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(revealed, [workspace], "the header's folder is the open agent's");
        await evaluate(`document.querySelector('button[aria-label="Configured"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(revealed, [workspace, configured], "a row's menu reveals that row's agent, not the open one");
      } finally {
        electron.shell.showItemInFolder = showItemInFolder;
        electron.Menu.prototype.popup = popup;
      }

      // Made last, so the rows earlier steps count on are untouched.
      await evaluate("document.querySelector('button[title^=\"New conversation\"]').click()");
      await until("document.body.innerText.includes('What should we work on?') && !document.querySelector('textarea').disabled", "a new conversation");
      await send("A second conversation, with a history of its own.");
      await until(
        `${reading} !== null && ${reading}.querySelectorAll('.column > *').length >= 2 && !document.querySelector('main .bounce')`,
        "the second conversation has settled",
      );
      await showConversations();
      const secondSession = await evaluate(`document.querySelector('#conversations button[data-session][aria-current="page"]').dataset.session`);
      await evaluate(`document.querySelector('#conversations').hidePopover()`);
      await watchForStartScreen();
      await showConversations();
      await evaluate(
        `[...document.querySelectorAll('#conversations button[data-session]')].find((b) => b.getAttribute('aria-current') !== 'page' && !b.textContent.includes('New conversation')).click()`,
      );
      await evaluate(`document.querySelector('#conversations').hidePopover()`);
      await settledOnHistory("the agent's other conversation opens");
      await noStartScreen("moving to another conversation");
      await watchForStartScreen();
      await showConversations();
      await evaluate(`document.querySelector('#conversations button[data-session="${secondSession}"]').click()`);
      await evaluate(`document.querySelector('#conversations').hidePopover()`);
      await settledOnHistory("and back to the second");
      await noStartScreen("moving back");

      await evaluate(`(() => {
        window.__draftWrite = Storage.prototype.setItem;
        window.__draftFull = true;
        Storage.prototype.setItem = function(key, value) {
          if (key === 'duang.drafts' && window.__draftFull) throw new Error('Synthetic draft storage full');
          return window.__draftWrite.call(this, key, value);
        };
      })()`);
      await type("Keep this unsent text");
      await until("document.body.innerText.includes('Synthetic draft storage full')", "a failed draft save is visible");
      assert.equal(await evaluate("document.querySelector('textarea').value"), "Keep this unsent text");
      await evaluate("window.__draftFull = false");
      await evaluate(`document.querySelector('button[title^="Model for this agent"]').click()`);
      await until("!document.body.innerText.includes('Draft storage needs attention')", "the same draft is saved after storage recovers");
      assert.match(await evaluate("localStorage.getItem('duang.drafts')"), /Keep this unsent text/);
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await until("document.querySelector('dialog') === null", "the picker closes after the storage check");
      await evaluate("Storage.prototype.setItem = window.__draftWrite; void 0");

      // Chromium does not run new-document scripts until the Page domain is enabled.
      await win.webContents.debugger.sendCommand("Page.enable");
      const protection = await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source: `localStorage.setItem('duang.drafts', '{original unsent text');
          window.__draftWrite = Storage.prototype.setItem;
          Storage.prototype.setItem = function(key, value) {
            if (key === 'duang.drafts.unreadable') throw new Error('Synthetic quarantine refused');
            return window.__draftWrite.call(this, key, value);
          };`,
      });
      win.webContents.reload();
      await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
      await until("document.body.innerText.includes('Synthetic quarantine refused') && document.querySelector('textarea')?.disabled === false", "a failed quarantine is visible and editing remains available");
      await type("New text stays in memory");
      await until("document.querySelector('textarea').value === 'New text stays in memory'", "the protected draft remains editable");
      assert.equal(await evaluate("localStorage.getItem('duang.drafts')"), "{original unsent text");
      assert.equal(await evaluate("localStorage.getItem('duang.drafts.unreadable')"), null);
      for (const mode of ["light", "dark"]) {
        electron.nativeTheme.themeSource = mode;
        await until(`matchMedia('(prefers-color-scheme: ${mode})').matches`, `${mode} draft warning`);
        await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        const image = await win.webContents.capturePage();
        await writeFile(fileURLToPath(new URL(`../out/draft-storage-${mode}.png`, import.meta.url)), image.toPNG());
      }
      await win.webContents.debugger.sendCommand("Page.removeScriptToEvaluateOnNewDocument", protection);
      await evaluate("Storage.prototype.setItem = window.__draftWrite; localStorage.removeItem('duang.drafts')");

      assert.equal(BrowserWindow.getAllWindows().length, 1);
      assert.deepEqual(errors, []);

      // ⌘, with every window closed: the request waits in main for the new renderer's listener.
      const closed = new Promise((resolve) => win.once("closed", resolve));
      win.close();
      await closed;
      Menu.getApplicationMenu().getMenuItemById("settings").click();
      const reopened = BrowserWindow.getAllWindows()[0];
      assert.ok(reopened, "Settings… opens a window when none is open");
      let onSettings = false;
      for (let i = 0; i < 200 && !onSettings; i++) {
        onSettings = await reopened.webContents
          .executeJavaScript("!!document.querySelector('#network-heading')", true)
          .catch(() => false);
        if (!onSettings) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(onSettings, "the new window lands on Settings");
      console.log(
        "Electron smoke passed: local workflow, duang's own credential file, connecting and disconnecting a provider, cross-provider history, missing/corrupt credentials and recovery",
      );
    } catch (error) {
      console.error(error);
      if (win && !win.isDestroyed()) {
        const image = await win.webContents.capturePage();
        const path = fileURLToPath(new URL("../out/smoke-failure.png", import.meta.url));
        await writeFile(path, image.toPNG());
        console.error(`Screenshot: ${path}`);
      }
      process.exitCode = 1;
    } finally {
      clearTimeout(timeout);
      if (win && !win.isDestroyed()) win.destroy();
      app.exit(process.exitCode ?? 0);
    }
  }
  void run().catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
