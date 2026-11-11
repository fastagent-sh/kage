// The live end of a run in the real window, only the model faked. Each step holds the run where it is checked
// (a tool waits for a file, the stream for a promise) rather than sleeping.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import electron from "electron";
import { chunk, isolated, openInstance, withoutCredentials, writeInstance } from "./harness.mjs";
import { open, windowDriver } from "./window.mjs";
import { checkAgentPointerRename } from "./layout.mjs";

const root = await isolated(import.meta.url, { name: "transcript", timeout: 120000, program: { model: { reasoning: true } } });
if (root) {
  const { app } = electron;
  withoutCredentials(process.env);
  const data = join(root, "user-data");
  const dir = join(root, "project");
  mkdirSync(data, { recursive: true });
  mkdirSync(dir, { recursive: true });
  app.setPath("userData", data);

  const script = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      const step = script.shift();
      assert.ok(step, "the model was asked more often than the scenario expects");
      if (step.status) {
        res.writeHead(step.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Overloaded", type: "server_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (step.thinking) res.write(chunk({ role: "assistant", reasoning_content: step.thinking }));
      if (step.text) res.write(chunk({ role: "assistant", content: step.text }));
      if (step.hold) await step.hold;
      if (step.rest) res.write(chunk({ content: step.rest }));
      if (step.tools)
        res.write(
          chunk({
            role: "assistant",
            tool_calls: step.tools.map((command, index) => ({ index, id: `call_${index}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } })),
          }),
        );
      res.write(chunk({}, step.tools ? "tool_calls" : "stop"));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.KAGE_MOCK_MODEL_URL = `http://127.0.0.1:${server.address().port}/v1`;
  writeInstance(dir, { model: "mock/mock" });
  // A second agent whose one conversation is already long: made by FastAgent itself, in the folder kage will open.
  const long = join(root, "long");
  writeInstance(long, { model: "mock/mock" });
  const LONG_TURNS = 40;
  {
    const agent = await openInstance(long);
    const { id } = await agent.sessions.create();
    for (let n = 1; n <= LONG_TURNS; n++) {
      script.push({ text: `Answer ${n}.` });
      const message = await agent.messages.send({ sessionId: id, content: `Turn ${n} of the long one` }, { wait: 60 });
      if (message.status !== "completed") throw new Error(`turn ${n} ${message.status}: ${message.error?.message}`);
    }
    await agent.close();
  }
  writeFileSync(
    join(data, "agents.json"),
    JSON.stringify([
      { id: "t", name: "Live", dir, colour: 3 },
      { id: "l", name: "Long", dir: long, colour: 5 },
    ]),
  );

  // Gives up after a minute, so a run killed before its gate leaves no shell looping.
  const waitsFor = (name) => `for i in $(seq 600); do [ -e gate-${name} ] && exit 0; sleep 0.1; done; exit 1`;
  const release = (name) => writeFileSync(join(dir, `gate-${name}`), "");
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  };

  let win;
  // Bound by `run` once the window exists; the helpers below read them through these.
  let until, type, send, evaluate, transcript;
  const live = () =>
    evaluate(`[...document.querySelectorAll('[aria-label="Transcript"] .bounce')].map((dot) => ({
      text: dot.parentElement.innerText.replace(/\\s+/g, " ").trim(),
      inBlock: !!dot.closest("summary"),
    }))`);
  const button = () => evaluate(`document.querySelector('button[aria-label="Stop the run"], button[aria-label="Steer the run"], button[aria-label="Send"]')?.getAttribute('aria-label')`);
  const idle = () => until(`!document.querySelector('button[aria-label="Stop the run"]') && !document.querySelector('[aria-label="Transcript"] .bounce')`, "the run ends", { timeout: 30000 });
  async function oneLine(what, { inBlock, says }) {
    const lines = await live();
    assert.equal(lines.length, 1, `${what}: one live line, not ${JSON.stringify(lines)}`);
    assert.equal(lines[0].inBlock, inBlock, `${what}: ${inBlock ? "in the step's own row" : "a line of its own"}`);
    assert.match(lines[0].text, says, what);
  }

  async function run() {
    win = await open();
    ({ until, type, send, evaluate, transcript } = windowDriver(win, { timeout: 20000, poll: 50 }));

    // Two calls running: their block is the live line, and the composer stops or steers.
    script.push({ text: "Checking.", tools: [waitsFor("a"), waitsFor("b")] }, { text: "Both done." });
    await send("run both");
    await until(`document.querySelectorAll('[aria-label="Transcript"] .bounce').length && /running 2 tools/.test(document.querySelector('[aria-label="Transcript"]').innerText)`, "two calls running");
    await oneLine("two calls running", { inBlock: true, says: /running 2 tools/ });
    assert.doesNotMatch(await transcript(), /ran 2 commands/, "nothing says they ran while they run");
    assert.equal(await button(), "Stop the run", "Stop with the field empty");
    await type("also the logs");
    await until(`!!document.querySelector('button[aria-label="Steer the run"]')`, "Steer once the field holds text");
    await type("");
    await until(`!!document.querySelector('button[aria-label="Stop the run"]')`, "Stop again once it is empty");
    release("a");
    await until(`!/running 2 tools/.test(document.querySelector('[aria-label="Transcript"]').innerText)`, "one call finished");
    await oneLine("the call left running", { inBlock: true, says: /running for .*gate-b/ });
    release("b");
    await until(`document.querySelector('[aria-label="Transcript"]').innerText.includes('Both done.')`, "the answer");
    await idle();
    assert.match(await transcript(), /ran 2 commands/, "finished, the block says what they did");

    // A lone call running is its own live line too.
    script.push({ tools: [waitsFor("c")] }, { text: "Lone done." });
    await send("run one");
    await until(`/gate-c/.test(document.querySelector('[aria-label="Transcript"] .bounce')?.parentElement.innerText ?? '')`, "a lone call running");
    await oneLine("a lone call running", { inBlock: true, says: /running for .*gate-c/ });
    release("c");
    await until(`document.querySelector('[aria-label="Transcript"]').innerText.includes('Lone done.')`, "its answer");
    await idle();

    // A thought being written is its own live line.
    const thought = deferred();
    script.push({ thinking: "Weighing the options.\nThe second one is ", hold: thought.promise, rest: "Thought through." });
    await send("think first");
    // Before the first word the status says `thinking` on its own line; the thought's own row takes it over.
    await until(`/Weighing the options/.test(document.querySelector('[aria-label="Transcript"] .bounce')?.parentElement.innerText ?? '')`, "a thought being written");
    await oneLine("a thought being written", { inBlock: true, says: /thinking Weighing the options\./ });
    thought.resolve();
    await until(`document.querySelector('[aria-label="Transcript"]').innerText.includes('Thought through.')`, "the answer after the thought");
    await idle();

    // An answer being written has no line under it.
    const answer = deferred();
    script.push({ text: "Half an answer", hold: answer.promise, rest: " and the rest." });
    await send("answer");
    await until(`document.querySelector('[aria-label="Transcript"]').innerText.includes('Half an answer')`, "an answer being written");
    assert.deepEqual(await live(), [], "the answer streaming is its own sign of life");
    answer.resolve();
    await idle();

    // A retry being waited out is said by one line, and once the run goes on, in the past above the answer.
    script.push({ status: 529 }, { text: "Answered after a retry." });
    await send("retry");
    await until(`/retrying 1\\/3/.test(document.querySelector('[aria-label="Transcript"] .bounce')?.parentElement.innerText ?? '')`, "a retry waited out");
    await oneLine("a retry waited out", { inBlock: false, says: /retrying 1\/3 the provider had a problem/ });
    assert.equal((await transcript()).match(/retrying 1\/3/g)?.length, 1, "said once, by the live line");
    await until(`document.querySelector('[aria-label="Transcript"]').innerText.includes('Answered after a retry.')`, "the answer after the retry", { timeout: 30000 });
    await idle();
    assert.match(await transcript(), /retried once: the provider had a problem/);
    assert.doesNotMatch(await transcript(), /retrying/, "no wait is left claimed");
    // Watched on every DOM change, so the batch timing does not matter.
    await evaluate(`(() => {
      const transcript = () => document.querySelector('[aria-label="Transcript"]');
      const has = (n) => transcript()?.innerText.includes('Turn ' + n + ' of the long one');
      window.__long = { first: undefined, moved: 0 };
      new MutationObserver(() => {
        const el = transcript();
        if (!el || !has(${LONG_TURNS})) return;
        if (window.__long.first === undefined) window.__long.first = has(1);
        window.__long.moved = Math.max(window.__long.moved, Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight));
      }).observe(document.body, { childList: true, subtree: true });
    })()`);
    await evaluate(`document.querySelector('aside button[aria-label="Long"]').click()`);
    await until(`document.querySelector('[aria-label="Transcript"]')?.innerText.includes('Turn 1 of the long one')`, "all of the long conversation drawn in the end");
    await new Promise((r) => setTimeout(r, 300));
    const { first, moved } = await evaluate("window.__long");
    assert.equal(first, false, "its latest turn is shown before its oldest is drawn");
    assert.ok(moved < 2, `the view stays at the latest line while older lines are drawn above it (it moved ${moved} px)`);
    // Scrolling up while older lines draw: not pulled to the latest line nor pushed to the oldest, and leaving
    // returns to the same place. A wheel event first: a returned view holds its place until the person scrolls.
    const atEnd = `(() => { const el = document.querySelector('[aria-label="Transcript"]'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true })); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); })()`;
    const shown = (text) => `document.querySelector('[aria-label="Transcript"]')?.innerText.includes(${JSON.stringify(text)})`;
    const offsetOf = (text) =>
      evaluate(`(() => { const el = document.querySelector('[aria-label="Transcript"]'); const row = [...el.querySelector('.column').children].find((r) => r.innerText === ${JSON.stringify(text)}); return row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null; })()`);
    const openLong = async () => {
      await evaluate(`document.querySelector('aside button[aria-label="Long"]').click()`);
      await until(shown("Turn 1 of the long one"), "all of the long conversation drawn");
      await new Promise((r) => setTimeout(r, 300));
    };
    const fromLive = async () => {
      await evaluate(atEnd);
      await evaluate(`document.querySelector('aside button[aria-label="Live"]').click()`);
      await until(shown("Answered after a retry."), "Live shown");
    };
    const scrollWhileDrawing = async (scroll, { leave = false } = {}) => {
      await fromLive();
      await evaluate(`(() => {
        window.__early = undefined;
        const observer = new MutationObserver(() => {
          const el = document.querySelector('[aria-label="Transcript"]');
          if (!el || !el.innerText.includes('Turn ${LONG_TURNS} of the long one') || window.__early) return;
          observer.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => {
            ${scroll};
            el.dispatchEvent(new Event('scroll'));
            const top = el.getBoundingClientRect().top + 60;
            const row = [...el.querySelector('.column').children].find((r) => r.getBoundingClientRect().bottom > top);
            window.__early = { text: row.innerText, offset: row.getBoundingClientRect().top - el.getBoundingClientRect().top, drawnAll: el.innerText.includes('Turn 1 of the long one') };
            if (${leave}) document.querySelector('aside button[aria-label="Live"]').click();
          }));
        });
        observer.observe(document.body, { childList: true, subtree: true });
      })()`);
      if (leave) {
        await evaluate(`document.querySelector('aside button[aria-label="Long"]').click()`);
        await until("window.__early !== undefined", "left the long conversation while it was being drawn");
        await until(shown("Answered after a retry."), "away on Live");
      }
      await openLong();
      await until("window.__early !== undefined", "the scroll sample was recorded");
      const early = await evaluate("window.__early");
      assert.equal(early.drawnAll, false, "acted while the older lines were still to be drawn");
      return { early, now: await offsetOf(early.text) };
    };
    for (const [scroll, what] of [
      ["el.scrollTop -= 400", "scrolled up"],
      // At scrollTop 0 Chromium's scroll anchoring does not hold the view: each batch would push it down.
      ["el.scrollTop = 0", "scrolled to the top of what is drawn"],
    ]) {
      const { early, now } = await scrollWhileDrawing(scroll);
      assert.ok(now !== null && Math.abs(now - early.offset) < 2, `a person who ${what} stays there as older lines arrive (row moved from ${early.offset} to ${now})`);
    }
    {
      const { early, now } = await scrollWhileDrawing("el.scrollTop -= 400", { leave: true });
      assert.ok(now !== null && Math.abs(now - early.offset) < 2, `coming back finds the place it was left at (row at ${now}, left at ${early.offset})`);
    }
    // A first batch shorter than the window leaves scrollTop 0 too. A 4000 px viewport (a real window is
    // screen-limited) is about the first 40 lines' height.
    await fromLive();
    win.webContents.debugger.attach();
    const [width] = win.getContentSize();
    await win.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height: 4000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(() => {
      window.__short = undefined;
      const observer = new MutationObserver(() => {
        const el = document.querySelector('[aria-label="Transcript"]');
        if (!el || !el.innerText.includes('Turn ${LONG_TURNS} of the long one')) return;
        observer.disconnect();
        window.__short = el.scrollHeight <= el.clientHeight;
      });
      observer.observe(document.body, { childList: true, subtree: true });
    })()`);
    await openLong();
    const short = await evaluate(`(() => {
      const el = document.querySelector('[aria-label="Transcript"]');
      return { firstFit: window.__short, overflowed: el.scrollHeight > el.clientHeight, fromEnd: el.scrollHeight - el.scrollTop - el.clientHeight };
    })()`);
    await win.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    win.webContents.debugger.detach();
    assert.ok(short.firstFit && short.overflowed, `the first batch fits the window and the whole conversation does not (${JSON.stringify(short)})`);
    assert.ok(short.fromEnd < 2, `a first batch shorter than the window still ends at the latest line (${JSON.stringify(short)})`);
    // Away while the run goes on: the same line comes back, and later output does not move it.
    const more = deferred();
    const rest = Array.from({ length: 30 }, (_, n) => `More output ${n + 1}.`).join("\n\n");
    script.push({ text: "Working on it.", tools: [waitsFor("d")] }, { text: "Part one.", hold: more.promise, rest: `\n\n${rest}` });
    await send("keep going");
    await until(`/running/.test(document.querySelector('[aria-label="Transcript"]').innerText)`, "the long conversation's run is working");
    const reading = await evaluate(`(() => {
      const el = document.querySelector('[aria-label="Transcript"]');
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
      el.scrollTop -= 600;
      el.dispatchEvent(new Event('scroll'));
      const top = el.getBoundingClientRect().top + 60;
      const row = [...el.querySelector('.column').children].find((r) => r.getBoundingClientRect().bottom > top);
      return { text: row.innerText, offset: row.getBoundingClientRect().top - el.getBoundingClientRect().top };
    })()`);
    await evaluate(`document.querySelector('aside button[aria-label="Live"]').click()`);
    await until(shown("Answered after a retry."), "away on Live");
    writeFileSync(join(long, "gate-d"), "");
    for (let t = 0; t < 400 && script.length > 0; t++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(script.length, 0, "the run went on to its answer while the person was away");
    await new Promise((r) => setTimeout(r, 500));
    await evaluate(`document.querySelector('aside button[aria-label="Long"]').click()`);
    await until(shown("Part one."), "back on the long conversation, with what was written while away");
    await new Promise((r) => setTimeout(r, 300));
    const returned = await offsetOf(reading.text);
    assert.ok(returned !== null && Math.abs(returned - reading.offset) < 2, `coming back to a run that went on finds the same line (row at ${returned}, left at ${reading.offset})`);
    more.resolve();
    await until(shown("More output 30."), "the rest of the answer arrives");
    await new Promise((r) => setTimeout(r, 300));
    const held = await offsetOf(reading.text);
    assert.ok(held !== null && Math.abs(held - reading.offset) < 2, `output arriving under a returned place does not move it (row at ${held}, left at ${reading.offset})`);
    await idle();
    // A place far above the last lines is drawn from its own line on return, the lines above it after: it is
    // where it was, and stays there while they are drawn.
    const far = await evaluate(`(() => {
      const el = document.querySelector('[aria-label="Transcript"]');
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
      el.scrollTop = 900;
      el.dispatchEvent(new Event('scroll'));
      const top = el.getBoundingClientRect().top + 60;
      const row = [...el.querySelector('.column').children].find((r) => r.getBoundingClientRect().bottom > top);
      return { text: row.innerText, offset: row.getBoundingClientRect().top - el.getBoundingClientRect().top };
    })()`);
    await evaluate(`document.querySelector('aside button[aria-label="Live"]').click()`);
    await until(shown("Answered after a retry."), "away on Live");
    await evaluate(`(() => {
      window.__far = undefined;
      const observer = new MutationObserver(() => {
        const el = document.querySelector('[aria-label="Transcript"]');
        if (!el || !el.innerText.includes(${JSON.stringify(far.text)})) return;
        observer.disconnect();
        window.__far = el.innerText.includes('Turn 1 of the long one');
      });
      observer.observe(document.body, { childList: true, subtree: true });
    })()`);
    await openLong();
    assert.equal(await evaluate("window.__far"), false, "a place far up is drawn before the lines above it");
    const farBack = await offsetOf(far.text);
    assert.ok(farBack !== null && Math.abs(farBack - far.offset) < 2, `a place far above the last lines is found again (row at ${farBack}, left at ${far.offset})`);
    // A place inside a card that was expanded: the card comes back folded, shorter than how far into it the place
    // was, so the place returns to the card's top rather than past it.
    const cardRow = `[...document.querySelectorAll('[aria-label="Transcript"] .column > [data-line]')].findLast((r) => r.querySelector('details'))`;
    const folded = await evaluate(`${cardRow}.offsetHeight`);
    await evaluate(`${cardRow}.querySelector('details').open = true`);
    await until(`${cardRow}.querySelectorAll('details').length > 1`, "the step's calls are shown");
    await evaluate(`${cardRow}.querySelectorAll('details')[1].open = true`);
    await new Promise((r) => setTimeout(r, 200));
    const card = await evaluate(`(() => {
      const el = document.querySelector('[aria-label="Transcript"]');
      const row = ${cardRow};
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
      const into = Math.round((${folded} + row.offsetHeight) / 2);
      el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top + into;
      el.dispatchEvent(new Event('scroll'));
      return { line: row.dataset.line, into, folded: ${folded}, open: row.offsetHeight };
    })()`);
    assert.ok(card.into > card.folded && card.into < card.open, `the place is inside the open card and past its folded height (${JSON.stringify(card)})`);
    await evaluate(`document.querySelector('aside button[aria-label="Live"]').click()`);
    await until(shown("Answered after a retry."), "away on Live");
    await openLong();
    const cardTop = await evaluate(`(() => {
      const el = document.querySelector('[aria-label="Transcript"]');
      return el.querySelector('[data-line="${card.line}"]').getBoundingClientRect().top - el.getBoundingClientRect().top;
    })()`);
    assert.ok(Math.abs(cardTop) < 2, `a place inside a card that comes back folded returns to its top (card at ${cardTop})`);

    // Math, links, and inline file paths render in the real window, and a missing file path surfaces its error.
    await evaluate(`document.querySelector('aside button[aria-label="Live"]').click()`);
    await until(shown("Answered after a retry."), "back on Live");
    script.push({
      text: "Formula $E = mc^2$, file `src/missing.ts:10`, and [Docs](https://fastagent.sh/docs).\n\n$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$",
    });
    await send("render math and links");
    await until(`document.querySelector('[aria-label="Transcript"] .katex-display') !== null`, "display math rendered");
    await idle();
    assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Transcript"] .katex').length >= 2`), true, "inline and display math rendered");
    assert.equal(
      await evaluate(`document.querySelector('[aria-label="Transcript"] a[data-streamdown="link"]')?.getAttribute('href')`),
      "https://fastagent.sh/docs",
      "external link rendered as an anchor without Streamdown's modal button",
    );
    await evaluate(`document.querySelector('[aria-label="Transcript"] button[title="Show src/missing.ts in Finder"]').click()`);
    await until(`document.body.innerText.includes('It could not be shown in Finder')`, "missing file path surfaces in the problem strip");

    // Pointer navigation owns the final selection/focus state, after all reading-position checks.
    win.webContents.debugger.attach();
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await checkAgentPointerRename(win, { evaluate, until, type }, ["Live", "Long"]);
    assert.equal(script.length, 0, "every scripted answer was asked for");
    console.log("Pointer rename passed: consecutive clicks at 100/200%, edit cancellation and roster dismissal.");
    console.log("Transcript live end passed: calls, a lone call, a thought, an answer and a retry each one line; a long conversation opens at its end and fills in above it.");
  }

  const timeout = setTimeout(() => {
    console.error("Transcript check timed out");
    app.exit(1);
  }, 110000);
  run()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      clearTimeout(timeout);
      server.close();
      for (const name of ["a", "b", "c"]) if (!existsSync(join(dir, `gate-${name}`))) release(name);
      app.exit(process.exitCode ?? 0);
    });
}
