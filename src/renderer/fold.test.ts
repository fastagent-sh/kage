import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entry, SessionEvent } from "@fastagent-sh/fastagent";
import { emptyFold, failureOf, foldEntries, foldEntry, foldNote, itemsOf, liveStep, noLive, stoppedNote } from "./fold.ts";
import { phase, summarize, type Item } from "./transcript.ts";

const entry = (id: string, kind: string, data: object): Entry => ({ id, timestamp: Number(id), kind, data }) as Entry;
const user = (id: string, text: string, messageId?: string) =>
  entry(id, "user", { content: [{ type: "text", text }], ...(messageId && { messageId }) });
const assistant = (id: string, data: object = {}) => entry(id, "assistant", { text: "", usage: {}, ...data });
const failed = (id: string, error: string) => assistant(id, { stop: "failed", error });
const call = (id: string, tool: string, args: object = {}) => assistant(id, { toolCalls: [{ id: tool, name: "bash", args }] });
const result = (id: string, toolCallId: string, text = "ok", isError = false, toolName = "bash") =>
  entry(id, "tool_result", { toolCallId, toolName, isError, content: [{ type: "text", text }] });
const shown = (entries: Entry[], running = false, live = noLive()) => itemsOf(foldEntries(entries), running, live);
const notes = (items: Item[]) => items.flatMap((item) => (item.kind === "note" ? [[item.tone, item.text]] : []));
const at = (event: SessionEvent) => event;
const delta = (channel: "text" | "thinking", text: string): SessionEvent => ({ type: "delta", channel, text });

test("history keeps the published kinds and skips the rest", () => {
  const items = shown([user("1", "hi", "m1"), assistant("2", { text: "yo" }), entry("3", "fastagent.plan", {})]);
  assert.deepEqual(items, [
    { kind: "user", text: "hi", at: 1, entryId: "1", messageId: "m1" },
    { kind: "assistant", text: "yo", open: false, at: 2 },
  ]);
});

test("a call and its result become one finished row; a result with no call still shows, marked when it failed", () => {
  const items = shown([call("1", "t1"), result("2", "t1", "ok")]);
  assert.deepEqual(items, [
    { at: 2, kind: "tool", id: "t1", name: "bash", args: {}, result: "ok", isError: false, status: "done" },
  ]);
  const orphan = shown([result("1", "t9", "boom", true)]);
  assert.equal(orphan.length, 1);
  assert.equal((orphan[0] as { isError?: boolean }).isError, true);
  assert.equal(
    (shown([entry("1", "tool_result", { toolCallId: "i", toolName: "view", isError: false, content: [{ type: "image", mimeType: "image/png", ref: "r" }] })])[0] as { result: string }).result,
    "[image]",
    "bytes never reach the transcript",
  );
});

test("an answer read back keeps its reasoning, and a call keeps its arguments", () => {
  const items = shown([
    user("1", "read it"),
    assistant("2", { thinking: "First the file.\nThen the answer.", toolCalls: [{ id: "a", name: "read", args: { path: "/r/a.ts" } }, { id: "b", name: "read", args: { path: "/r/a.ts" } }] }),
    result("3", "a", "x", false, "read"),
    result("4", "b", "x", false, "read"),
    assistant("5", { text: "done" }),
  ]);
  assert.deepEqual(items.map((item) => item.kind), ["user", "thinking", "tool", "tool", "assistant"], "the thought before the calls it led to");
  const thought = items[1] as Extract<Item, { kind: "thinking" }>;
  assert.deepEqual([thought.text, thought.open], ["First the file.\nThen the answer.", false]);
  assert.equal(summarize(items.slice(1, 4) as never), "thought, read 1 file", "the same file twice is one file, as live");
});

test("only the newest turn's unanswered calls run; earlier ones stay stopped", () => {
  const entries = [user("1", "earlier"), call("2", "old"), user("3", "now"), call("4", "new")];
  const status = (items: Item[], id: string) => (items.find((item) => item.kind === "tool" && item.id === id) as { status: string }).status;
  const live = shown(entries, true);
  assert.equal(status(live, "old"), "interrupted");
  assert.equal(status(live, "new"), "running");
  assert.equal(status(shown(entries, false), "new"), "interrupted", "a conversation that is not running is not executing");
});

test("a tool running live keeps when it started and its status line; one read from history has no time", () => {
  const entries = [user("1", "go"), call("2", "a"), result("3", "a"), call("4", "b")];
  let live = noLive();
  live = liveStep(live, at({ type: "tool_started", toolCallId: "b", name: "bash", args: {} }), 5_000);
  live = liveStep(live, at({ type: "tool_progress", toolCallId: "b", text: "step 2" }), 6_000);
  const running = shown(entries, true, live).find((item) => item.kind === "tool" && item.id === "b") as Extract<Item, { kind: "tool" }>;
  assert.deepEqual([running.status, running.started, running.result], ["running", 5_000, "step 2"]);
  const history = shown(entries, false).find((item) => item.kind === "tool" && item.id === "b") as Extract<Item, { kind: "tool" }>;
  assert.equal(history.started, undefined);
  // Its result lands as an entry and the live line is gone.
  assert.deepEqual(liveStep(live, at({ type: "entry", entry: result("5", "b") }), 7_000).tools, {});
});

test("the reply being written is shown from the deltas, thinking closes when the answer starts, and its entry replaces it", () => {
  const entries = [user("1", "hi")];
  let live = noLive();
  live = liveStep(live, delta("thinking", "pl"), 1_000);
  live = liveStep(live, delta("thinking", "an"), 1_500);
  live = liveStep(live, delta("text", "He"), 2_000);
  live = liveStep(live, delta("text", "llo"), 3_000);
  const [, thought, answer] = shown(entries, true, live) as Extract<Item, { kind: "thinking" | "assistant" }>[];
  assert.deepEqual(thought, { kind: "thinking", text: "plan", open: false, started: 1_000, at: 2_000 });
  assert.deepEqual(answer, { kind: "assistant", text: "Hello", open: true, at: 2_000 });
  const after = liveStep(live, at({ type: "entry", entry: assistant("2", { text: "Hello" }) }), 4_000);
  assert.deepEqual([after.text, after.thinking], [undefined, undefined]);
  // Attached mid-answer: the snapshot's reply is what is shown, and what follows is added to it.
  const snapshot = liveStep(noLive(), at({ type: "state", session: { id: "s", status: "running", reply: { text: "Hel" }, usage: { models: {}, tools: {} } } as never }), 10);
  assert.equal(liveStep(snapshot, delta("text", "lo"), 11).text?.text, "Hello");
});

test("a retry being waited out is one line, and the failed attempt's entry is not the run's ending", () => {
  const entries = [user("1", "summarise it")];
  let live = liveStep(noLive(), at({ type: "retrying", attempt: 1, maxAttempts: 3, delayMs: 2000, reason: "Anthropic API error (429): rate_limit_error" }), 5);
  const waiting = shown(entries, true, live);
  assert.deepEqual(notes(waiting), [["info", "retrying 1/3: the provider is limiting requests"]]);
  assert.deepEqual(phase(waiting, "running"), { word: "retrying 1/3", detail: "the provider is limiting requests", activity: "thinking" });
  // The failed attempt is recorded after the event announcing the retry; it keeps the wait on screen.
  const recorded = [...entries, failed("2", "Anthropic API error (429): rate_limit_error")];
  live = liveStep(live, at({ type: "entry", entry: recorded[1]! }), 6);
  assert.deepEqual(notes(shown(recorded, true, live)), [["info", "retrying 1/3: the provider is limiting requests"]]);
  // The next attempt writes: the wait is over and the line says it in the past.
  live = liveStep(live, delta("text", "Here"), 7);
  assert.deepEqual(notes(shown(recorded, true, live)), [["info", "retried once: the provider is limiting requests"]]);
  // When it answers, the record says the same.
  assert.deepEqual(notes(shown([...recorded, assistant("3", { text: "Here" })])), [["info", "retried once: the provider is limiting requests"]]);
});

test("history says how an answer ended, as a watcher saw it live, and offers a failed run's message again", () => {
  // The agent retried twice, then gave up: only the last failure is the run's, and the retry line goes.
  const gaveUp = shown([user("1", "summarise it"), failed("2", "Connection error."), failed("3", "Connection error."), failed("4", "Connection error.")]);
  assert.deepEqual(notes(gaveUp), [["error", "run failed: Connection error."]]);
  assert.deepEqual((gaveUp.at(-1) as { resend?: unknown }).resend, { text: "summarise it", toolsRan: false });
  // Still running, the last failure is a retry waiting out its delay.
  assert.deepEqual(notes(shown([user("1", "summarise it"), failed("2", "overloaded")], true)), [["info", "retried once: the provider had a problem"]]);

  const ended = shown([
    user("1", "a"),
    assistant("2", { text: "partial answer", stop: "failed", error: "socket hang up" }),
    user("3", "b"),
    assistant("4", { stop: "aborted" }),
    user("5", "c"),
    assistant("6", { text: "a long answ", stop: "max_tokens" }),
  ]);
  assert.deepEqual(notes(ended), [
    ["error", "run failed: socket hang up"],
    ["info", "run stopped"],
    ["info", "answer cut off at the model's output limit"],
  ]);
  assert.equal(ended.find((item) => item.kind === "assistant")?.kind, "assistant", "the partial text stays, with its failure under it");

  // Work no answer concluded counts, a steer's included; work an earlier answer concluded does not.
  const resend = (entries: Entry[]) => (shown(entries).at(-1) as { resend?: unknown }).resend;
  assert.deepEqual(resend([user("1", "fix the build"), call("2", "t1"), result("3", "t1"), user("4", "and push it"), failed("5", "x")]), { text: "and push it", toolsRan: true });
  assert.deepEqual(resend([user("1", "fix the build"), call("2", "t1"), result("3", "t1"), assistant("4", { text: "fixed" }), user("5", "thanks"), failed("6", "x")]), { text: "thanks", toolsRan: false });
  assert.deepEqual(resend([user("1", "one"), call("2", "t1"), result("3", "t1"), failed("4", "x"), user("5", "two"), failed("6", "y")]), { text: "two", toolsRan: false }, "an earlier run's failure ended its work too");
});

test("a turn cut partway with nothing recorded says so and offers its message again; a finished or running one does not", () => {
  const last = (items: Item[]) => items.at(-1) as Extract<Item, { kind: "note" }>;
  const cut = "run cut short: no answer was recorded";
  assert.deepEqual(last(shown([user("1", "fix the build")])).resend, { text: "fix the build", toolsRan: false });
  assert.equal(last(shown([user("1", "fix the build")])).text, cut);
  assert.deepEqual(last(shown([user("1", "fix"), call("2", "t1"), result("3", "t1")])).resend, { text: "fix", toolsRan: true }, "after a tool's result the work may be repeated");
  assert.equal(last(shown([user("1", "fix"), call("2", "t1")])).text, cut);
  assert.equal(shown([user("1", "fix"), call("2", "t1"), result("3", "t1"), assistant("4", { text: "fixed" })]).at(-1)?.kind, "assistant");
  assert.equal(last(shown([user("1", "fix"), assistant("2", { stop: "aborted" })])).text, "run stopped");
  assert.equal(shown([user("1", "fix"), call("2", "t1"), result("3", "t1")], true).at(-1)?.kind, "tool", "a running turn is not cut");
  assert.deepEqual(shown([]), [], "a conversation with no message yet is not cut");
  // A compaction empties the context but leaves a failed turn failed.
  assert.equal(last(shown([user("1", "summarise it"), failed("2", "context overflow")])).text, "run failed: context overflow");
});

test("how a message ended is a line the record does not hold, said once", () => {
  const fold = foldEntries([user("1", "go", "m1"), call("2", "t1"), result("3", "t1")]);
  const stopped = stoppedNote(fold, 9)!;
  assert.deepEqual(stopped, { kind: "note", tone: "info", text: "run stopped", at: 9 });
  const after = foldNote(fold, stopped);
  assert.equal(after.open, false, "the turn is not waiting on an answer any more, so it is not cut short");
  assert.deepEqual(notes(itemsOf(after, false, noLive())), [["info", "run stopped"]]);
  assert.equal(stoppedNote(after, 10), undefined, "a line already says it");

  const error = { code: "auth_required", message: "No API key found for anthropic." };
  const note = failureOf(fold, error, 9)! as Extract<Item, { kind: "note" }>;
  assert.equal(note.fix, "providers", "FastAgent's own code decides the fix");
  assert.deepEqual(note.resend, { text: "go", toolsRan: true });
  assert.equal(failureOf(foldEntries([user("1", "go"), failed("2", "x")]), error, 9), undefined, "the answer's own entry already says it");
});

test("a ChatGPT plan's usage limit names the provider whose page says more", () => {
  const reason = "OpenAI API error (429): subscription_sharing_usage_limit_exceeded\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage";
  const limit = (items: Item[]) => (items.at(-1) as { limit?: string }).limit;
  assert.equal(limit(shown([user("1", "hi"), failed("2", reason)])), "openai");
  assert.equal(limit(shown([user("1", "hi"), failed("2", "Connection error.")])), undefined);
});

test("the context is how full the newest answer says it is, and a compaction empties it", () => {
  const tokens = (inputTokens: number) => ({ usage: { inputTokens, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1 } });
  assert.equal(foldEntries([user("1", "a"), assistant("2", { text: "x", ...tokens(100) })]).context, 116);
  assert.equal(foldEntries([user("1", "a"), assistant("2", { text: "x", ...tokens(100) }), assistant("3", { text: "y", ...tokens(200) })]).context, 216);
  assert.equal(foldEntries([user("1", "a"), assistant("2", { text: "x", ...tokens(100) }), entry("3", "compaction", { summary: "s" })]).context, undefined);
});

test("an entry leaves every item before it the same object, and one the history already holds is not added twice", () => {
  const fold = foldEntries([user("1", "go"), assistant("2", { text: "Earlier answer" }), call("3", "a"), result("4", "a")]);
  const next = foldEntry(fold, assistant("5", { text: "Next" }));
  fold.items.forEach((item, index) => assert.equal(next.items[index], item, `${item.kind} kept`));
  assert.equal(next.items.length, fold.items.length + 1);
  assert.equal(foldEntry(next, assistant("5", { text: "Next" })), next, "the same entry again changes nothing");
  assert.equal(foldEntry(emptyFold(), user("1", "x")).items.length, 1);
  // While running, only the newest turn's calls are rebuilt.
  const running = itemsOf(next, true, noLive());
  const settled = next.items.filter((item) => item.kind !== "tool");
  settled.forEach((item) => assert.ok(running.includes(item)));
});
