// Not in CI: timing depends on the machine. Run before and after a transcript rendering change and compare.
// M-series, 150 turns: open ~0.15 s, switch back ~40 ms, scroll p95 ~18 ms, stream p50 ~17 ms.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import electron from "electron";
import { chunk, isolated, withoutCredentials, writeMockAgent } from "./harness.mjs";
import { open, sleep, windowDriver } from "./window.mjs";

const TURNS = Number(process.env.TURNS ?? 150);
const serve = (respond) => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      void respond(res);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
};
const writeAgent = (dir, port) => writeMockAgent(dir, port, { model: { reasoning: true, contextWindow: 10000000 } });
withoutCredentials(process.env);

const root = await isolated(import.meta.url, {
  name: "perf",
  timeout: 240000,
  async prepare(root) {
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    let call = 0;
    const answer = (n) =>
      `## Turn ${n}: what changed\n\nThe build failed because the parser read a quoted note's commas as columns. ` +
      "I changed `parseExpenses` to split on commas outside quotes, added a test, and ran the suite.\n\n" +
      "```ts\nexport function splitRow(line: string): string[] {\n  const out: string[] = [];\n  let field = \"\";\n  let quoted = false;\n  for (const ch of line) {\n    if (ch === '\"') quoted = !quoted;\n    else if (ch === \",\" && !quoted) { out.push(field); field = \"\"; }\n    else field += ch;\n  }\n  out.push(field);\n  return out;\n}\n```\n\n" +
      Array.from({ length: 6 }, (_, i) => `- Point ${i + 1}: ${"the totals now match the fixture, and the table is aligned. ".repeat(2)}`).join("\n") +
      "\n\n| Category | Before | After |\n|---|---|---|\n| Food | 8.50 | 16.50 |\n| Rent | 950.00 | 950.00 |\n";
    const server = await serve(async (res) => {
      const n = Math.floor(call / 2) + 1;
      if (call++ % 2 === 0) {
        res.write(chunk({ role: "assistant", reasoning_content: `Turn ${n}. ${"I should look at the parser, run the tests, and check the fixture first. ".repeat(6)}` }));
        res.write(chunk({ content: "Let me look at the code and run the tests." }));
        const bash = (index, command) => ({ index, id: `${index}-${n}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } });
        res.write(chunk({ tool_calls: [bash(0, "seq 1 400"), bash(1, "yes 'test: parses a quoted note ... ok' | head -60"), bash(2, "ls src test")] }));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ role: "assistant", content: answer(n) }));
        res.write(chunk({}, "stop"));
      }
      res.end("data: [DONE]\n\n");
    });
    writeAgent(project, server.address().port);
    // The conversation lives in the instance kage will open: its state directory, for the agent id below.
    const { openAgent } = await import("@fastagent-sh/fastagent");
    const agent = await openAgent(project, { stateDir: join(root, "user-data", "instances", "l") });
    const { id } = await agent.sessions.create();
    for (let n = 1; n <= TURNS; n++) {
      const message = await agent.messages.send({ sessionId: id, content: `Turn ${n}: the build is failing again, find out why and fix it.` }, { wait: 120 });
      if (message.status !== "completed") throw new Error(`turn ${n} ${message.status}: ${message.error?.message}`);
    }
    await agent.close();
    server.close();
  },
});
if (root) {
  const { app } = electron;
  const project = join(root, "project");
  const other = join(root, "other");
  const data = join(root, "user-data");
  mkdirSync(data, { recursive: true });
  // A new turn in the long conversation: a long answer streamed word by word.
  const server = await serve(async (res) => {
    const words = ("The parser now splits on commas outside quotes. " + "Here is `code` and **bold** text in a paragraph that keeps going. ".repeat(3) + "\n\n").repeat(40).split(/(?<= )/);
    for (const word of words) {
      res.write(chunk({ role: "assistant", content: word }));
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    res.write(chunk({}, "stop"));
    res.end("data: [DONE]\n\n");
  });
  for (const dir of [project, other]) writeAgent(dir, server.address().port);
  writeFileSync(join(data, "agents.json"), JSON.stringify([{ id: "l", name: "Long", dir: project, colour: 3 }, { id: "o", name: "Other", dir: other, colour: 5 }]));
  app.setPath("userData", data);
  let win;
  let evaluate, until, type;
  const frames = (ms) =>
    evaluate(`new Promise((resolve) => { const d = []; let last = performance.now(); const end = last + ${ms}; const step = (t) => { d.push(t - last); last = t; if (t < end) requestAnimationFrame(step); else resolve(d); }; requestAnimationFrame(step); })`);
  const quantile = (d, q) => [...d].sort((a, b) => a - b)[Math.min(d.length - 1, Math.floor(q * d.length))];
  const describe = (d) => `p50 ${quantile(d, 0.5).toFixed(1)} ms, p95 ${quantile(d, 0.95).toFixed(1)} ms, ${d.filter((x) => x > 50).length}/${d.length} frames over 50 ms`;
  const loaded = `document.querySelector('[aria-label="Transcript"]')?.innerText.includes('Turn ${TURNS}:') && !document.querySelector('[aria-busy=true]')`;

  async function run() {
    win = await open({ size: [1280, 820] });
    ({ evaluate, until, type } = windowDriver(win, { timeout: 60000, poll: 10 }));
    await evaluate(`window.__long = []; new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(e.duration); }).observe({ type: "longtask" }); 1`);
    const opened = await until(loaded, "the long conversation opens");
    // The rest is drawn above in batches: the view must not move while it is, and no batch may freeze it.
    const anchor = `(() => { const el = document.querySelector('[aria-label="Transcript"]'); return el.scrollHeight - el.scrollTop - el.clientHeight; })()`;
    const before = await evaluate(anchor);
    const complete = await until(`document.querySelector('[aria-label="Transcript"]').innerText.includes('Turn 1:')`, "the whole conversation drawn");
    const after = await evaluate(anchor);
    const longest = await evaluate("Math.max(0, ...window.__long)");
    const nodes = await evaluate("document.querySelectorAll('*').length");
    await evaluate(`document.querySelector('aside button[aria-label="Other"]').click()`);
    await until("document.body.innerText.includes('What should we work on')", "another agent");
    await sleep(500);
    const start = Date.now();
    await evaluate(`document.querySelector('aside button[aria-label="Long"]').click()`);
    await until(loaded, "back to the long conversation");
    const back = Date.now() - start;
    await until(`document.querySelector('[aria-label="Transcript"]').innerText.includes('Turn 1:')`, "all of it drawn again");
    await sleep(300);
    const height = await evaluate(`document.querySelector('[aria-label="Transcript"]').scrollHeight`);
    const scrolling = evaluate(`new Promise((resolve) => { const el = document.querySelector('[aria-label="Transcript"]'); el.scrollTop = el.scrollHeight; const step = () => { el.scrollTop -= 120; if (el.scrollTop > 0) requestAnimationFrame(step); else resolve(); }; requestAnimationFrame(step); })`);
    const scroll = await frames(Math.min(20000, (height / 120) * 18));
    await scrolling;
    await evaluate(`document.querySelector('[aria-label="Transcript"]').scrollTop = 1e9`);
    await type("one more");
    await until("!!document.querySelector('button[aria-label=Send]')", "Send");
    const streaming = frames(8000);
    await evaluate("document.querySelector('button[aria-label=Send]').click()");
    const stream = await streaming;
    await until(`!document.querySelector('button[aria-label="Stop the run"]')`, "the turn ends");
    const heap = await evaluate("performance.memory.usedJSHeapSize");
    console.log(`Long conversation, ${TURNS} turns, ${nodes} DOM nodes:`);
    console.log(`  open at launch  ${opened} ms; all of it drawn ${complete} ms later, the view moved ${Math.abs(after - before)} px, longest task ${longest.toFixed(0)} ms`);
    console.log(`  switch back     ${back} ms`);
    console.log(`  scroll ${Math.round(height)} px: ${describe(scroll)}`);
    console.log(`  stream a long answer: ${describe(stream)}`);
    console.log(`  JS heap after   ${(heap / 1048576).toFixed(0)} MB`);
    assert.ok(quantile(stream, 0.5) < 33, `a new turn streams at under 30 frames a second in a ${TURNS}-turn conversation`);
    assert.ok(Math.abs(after - before) < 2, `the view stays at the latest line while the older lines are drawn (moved ${after - before} px)`);
  }
  run()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      server.close();
      app.exit(process.exitCode ?? 0);
    });
}
