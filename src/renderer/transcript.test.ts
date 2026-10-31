import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dayLabel,
  duration,
  firstArg,
  foldHead,
  group,
  lineOf,
  lines,
  liveEnd,
  placeAt,
  phase,
  summarize,
  previewOf,
  thinkingLine,
  opensRun,
  queueView,
  toolText,
  type Item,
  type UserItem,
} from "./transcript.ts";

test("a message opens a run when there is none to join, and a steer joins the one going", () => {
  assert.equal(opensRun(undefined), true, "a conversation not read yet");
  assert.equal(opensRun("idle"), true);
  assert.equal(opensRun("running"), false, "a steer");
});

test("the queue lists this window's messages: held by FastAgent once it has their id, sending before", () => {
  const opening: UserItem = { kind: "user", text: "/compact", at: 1, opens: true };
  const steer: UserItem = { kind: "user", text: "and also", at: 2, opens: false, messageId: "m2" };
  assert.deepEqual(
    queueView([opening, steer]).map(({ item, listed, opens }) => [item.text, listed, opens]),
    [["/compact", false, true], ["and also", true, false]],
  );
});

test("a duration reads as pi writes it", () => {
  assert.equal(duration(3_240), "3.2s");
  assert.equal(duration(59_990), "60.0s");
  assert.equal(duration(125_000), "2m 5s");
  assert.equal(duration(3_725_000), "1h 2m 5s");
  // Still running, the clock ticks by the second, so it does not show tenths it cannot track.
  assert.equal(duration(2_400, true), "2s");
  assert.equal(duration(125_000, true), "2m 5s");
});

test("tool output comes out of its envelope, and an unknown shape keeps its JSON", () => {
  assert.equal(toolText("plain"), "plain");
  assert.equal(toolText({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }), "one\ntwo");
  // The shape the runtime actually sends: content wrapping content.
  assert.equal(toolText({ content: { content: [{ type: "text", text: "deep" }], details: {} } }), "deep");
  // An image part is not text; dropping it would hide the result entirely.
  const image = { content: [{ type: "image", data: "…" }] };
  assert.equal(toolText(image), JSON.stringify(image, null, 2));
});

test("tool summaries keep the beginning of commands and the end of file paths", () => {
  const command = '/bin/sh -c "curl https://example.com/api/v1/start"';
  assert.equal(firstArg({ command }), command);
  const longCommand = command + " --header " + "x".repeat(80);
  assert.equal(firstArg({ command: longCommand }), `${longCommand.slice(0, 71)}…`);
  assert.equal(firstArg({ path: "/tmp/project/hello.txt" }), "…/project/hello.txt");
  assert.equal(firstArg({ pattern: "/api/v1/start" }), "/api/v1/start");
});

test("a preview quotes the call still running, not one started after it that already finished", () => {
  const items = [
    tool("bash", { command: "sleep 6" }, { status: "running", id: "a" }),
    tool("bash", { command: "ls" }, { id: "b" }),
  ] as Item[];
  assert.equal(previewOf(items)?.text, "bash sleep 6");
  assert.equal(previewOf([items[0]!, { ...(items[1] as object), status: "running" } as Item])?.text, "bash ls");
});

test("a preview quotes the newest output as plain text, and follows a streaming answer", () => {
  assert.equal(previewOf([]), undefined);
  let items: Item[] = [{ kind: "user", text: "Deploy it", at: 1 }];
  assert.deepEqual(previewOf(items), { text: "You: Deploy it", at: 1 });
  // Thinking still going is what the agent is doing now: the line it is on.
  items = [...items, { kind: "thinking", text: "first\nnow the build\n", open: true, at: 2, started: 2 }];
  assert.equal(previewOf(items)?.text, "thinking: now the build");
  // Settled, it is not output, and is passed over.
  assert.equal(previewOf([items[0]!, { ...(items[1] as never as object), open: false } as Item])?.text, "You: Deploy it");
  items = [...items, { kind: "tool", id: "t", name: "bash", args: { command: "npm run build" }, status: "running", at: 3 }];
  assert.equal(previewOf(items)?.text, "bash npm run build");
  items = [...items, { kind: "assistant", text: "## Done\n\nThe **build**", open: true, at: 4 }];
  assert.deepEqual(previewOf(items), { text: "Done The build", at: 4 });
  items = [...items.slice(0, -1), { kind: "assistant", text: "## Done\n\nThe **build** passed with `0` errors.", open: true, at: 4 }];
  assert.equal(previewOf(items)?.text, "Done The build passed with 0 errors.");
});

test("long output folds by lines and by characters, and short output does not fold", () => {
  assert.equal(foldHead("one\ntwo"), undefined);
  const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(foldHead(many)?.split("\n").length, 12);
  // One line with no ceiling — minified JSON, a curl body — is what line counting alone missed.
  const wide = "x".repeat(10_000);
  assert.equal(foldHead(wide)?.length, 1_500);
});

test("a day boundary becomes its own line, and only where the day actually changes", () => {
  const day1 = Date.UTC(2026, 0, 19, 23, 0, 0);
  const day2 = Date.UTC(2026, 0, 21, 9, 0, 0);
  const items: Item[] = [
    { kind: "user", text: "yesterday", at: day1 },
    { kind: "assistant", text: "answer", open: false, at: day1 + 1000 },
    { kind: "user", text: "today", at: day2 },
  ];
  assert.deepEqual(
    lines(items).map((line) => (line.kind === "day" ? "—day—" : line.kind)),
    ["user", "assistant", "—day—", "user"],
  );
  // Nothing to separate inside one day.
  assert.equal(lines([items[0]!, items[1]!]).length, 2);
});

test("a day label crosses the year, not a count of days", () => {
  const jan = Date.UTC(2026, 0, 5, 12, 0, 0);
  assert.equal(dayLabel(jan, jan), "Today");
  assert.equal(dayLabel(jan - 86_400_000, jan), "Yesterday");
  // Eleven days back, but a different year: the year has to be said or it reads as this December.
  assert.match(dayLabel(Date.UTC(2025, 11, 25, 12, 0, 0), jan), /2025/);
  assert.doesNotMatch(dayLabel(Date.UTC(2026, 0, 1, 12, 0, 0), jan), /2026/);
});

const tool = (name: string, args: unknown, extra: Partial<Extract<Item, { kind: "tool" }>> = {}): Item => ({
  kind: "tool",
  id: Math.random().toString(),
  name,
  args,
  status: "done",
  at: 0,
  ...extra,
});

test("consecutive tool calls and thinking fold into one work block, which prose ends", () => {
  const answer: Item = { kind: "assistant", text: "ok", open: false, at: 0 };
  const shown = group([tool("read", { path: "a" }), answer, tool("read", { path: "a" }), tool("bash", { command: "ls" }), answer]);
  // A lone call is a block of one, so the next call extends it rather than replacing it on screen.
  assert.deepEqual(
    shown.map((line) => (line.kind === "work" ? line.items.length : line.kind)),
    [1, "assistant", 2, "assistant"],
  );
});

test("a work block counts files once and names the kind of work", () => {
  const thinking: Item = { kind: "thinking", text: "", open: false, started: 0, at: 4000 };
  const text = summarize([
    thinking,
    tool("read", { path: "/x/a.ts" }),
    tool("read", { path: "/x/a.ts" }),
    tool("read", { path: "/x/b.ts" }),
    tool("bash", { command: "npm test" }, { isError: true }),
    tool("grep", { pattern: "foo" }),
    tool("mcp_search", {}),
    tool("mcp_search", {}),
  ] as never);
  assert.equal(text, "thought 4s, read 2 files, searched once, ran 1 command, used mcp_search \u00d72");
  // Counted by the real path: two index.ts files in different packages are two files.
  assert.equal(summarize([tool("read", { path: "/r/packages/a/src/index.ts" }), tool("read", { path: "/r/packages/b/src/index.ts" })] as never), "read 2 files");
  // The path, not whichever string argument comes first.
  assert.equal(summarize([tool("edit", { oldText: "x", path: "/a.ts" }), tool("edit", { oldText: "x", path: "/b.ts" })] as never), "changed 2 files");
  // A call that never finished is said, unlike one that failed: nothing else says the run was cut short.
  assert.equal(
    summarize([tool("bash", {}, { isError: true }), tool("bash", {}, { status: "interrupted" })] as never),
    "ran 2 commands, 1 stopped",
  );
  // History carries no arguments, so every reopened call counts on its own.
  assert.equal(summarize([tool("read", undefined), tool("read", undefined)] as never), "read 2 files");
  // A call still running is not counted as done: the block says how many run, the live status what they are.
  assert.equal(summarize([tool("bash", {}, { status: "running", id: "a" }), tool("bash", {}, { status: "running", id: "b" })] as never), "2 running");
  assert.equal(summarize([tool("bash", {}, { id: "a" }), tool("bash", {}, { status: "running", id: "b" })] as never), "ran 1 command, 1 running");
});

test("a streaming thought is quoted by a line it finished, never one cut mid-word", () => {
  // The last line is still being written: the one before it is what the model last said in full.
  assert.equal(thinkingLine("The user wants me to:\n1. Find out why it fails\n- The tot", true), "1. Find out why it fails");
  assert.equal(thinkingLine("The user wants me to:\n1. Find out why it fails\n", true), "1. Find out why it fails");
  // No line finished yet: the words so far, without the one being written.
  assert.equal(thinkingLine("Let me look at the tes", true), "Let me look at the");
  assert.equal(thinkingLine("Let me", true), "Let");
  // A spaced script's first word alone may be half-written: nothing yet.
  assert.equal(thinkingLine("Th", true), "");
  // A script written without spaces has no word to leave out: what it has written so far.
  assert.equal(thinkingLine("让我看看这个测试为什么失败", true), "让我看看这个测试为什么失败");
  // Settled, the last line is complete and is the one shown.
  assert.equal(thinkingLine("first\n- The total is right"), "- The total is right");
  // The live status and the preview read it the same way.
  const streaming: Item = { kind: "thinking", text: "first line\n- The tot", open: true, started: 0, at: 0 };
  assert.equal(phase([streaming], "running").detail, "first line");
  assert.equal(previewOf([streaming])?.text, "thinking: first line");
  assert.equal(phase([{ ...streaming, text: "" } as Item], "running").detail, undefined, "nothing worth saying yet");
  // Nothing to quote yet: the preview says thinking, not a label with nothing after it.
  assert.equal(previewOf([{ ...streaming, text: "" } as Item])?.text, "thinking");
});

test("the live status says what the run is doing now", () => {
  const answering: Item = { kind: "assistant", text: "x", open: true, at: 0 };
  const thinking: Item = { kind: "thinking", text: "first\nnow the tests\n", open: true, started: 0, at: 0 };
  const build = tool("bash", { command: "npm test" }, { status: "running", id: "t1" });
  assert.deepEqual(phase([], undefined), { word: "starting", activity: "thinking" });
    assert.deepEqual(phase([], "running"), { word: "thinking", detail: undefined, activity: "thinking" });
  // Thinking says the line it is on.
  assert.deepEqual(phase([thinking], "running"), { word: "thinking", detail: "now the tests", activity: "thinking" });
  assert.deepEqual(phase([answering], "running"), { word: "answering", activity: "answering" });
  assert.deepEqual(phase([build], "running"), { word: "running", detail: "npm test", activity: "tool" });
  assert.deepEqual(phase([tool("read", { path: "/a/b/c.ts" }, { status: "running", id: "r" })], "running"), {
    word: "reading",
    detail: "\u2026/b/c.ts",
    activity: "tool",
  });
  assert.deepEqual(phase([tool("read", {}, { status: "running" }), tool("bash", {}, { status: "running" })], "running"), {
    word: "running 2 tools",
    activity: "tool",
  });
});

test("the live end of a run is one line: the step itself when it is the newest line", () => {
  const user: Item = { kind: "user", text: "go", at: 0 };
  const end = (items: Item[], busy = true, opening = false) => {
    const shown = group(lines(items));
    const result = liveEnd(shown, busy, opening);
    return {
      status: result.status,
      block: result.block ? shown.indexOf(result.block) : undefined,
      hidden: result.hidden ? shown.indexOf(result.hidden) : undefined,
      quietOnly: result.quietOnly,
      above: result.above,
    };
  };
  const running = (id: string) => tool("bash", { command: `sleep ${id}` }, { status: "running", id });
  const waiting: Item = { kind: "note", tone: "info", text: "retrying 1/3: the provider had a problem", retry: 1, of: 3, reason: "529", at: 0 };

  assert.deepEqual(end([user], false), { status: false, block: undefined, hidden: undefined, quietOnly: false, above: "user" }, "no run, no line");
  assert.deepEqual(end([user]), { status: true, block: undefined, hidden: undefined, quietOnly: false, above: "user" });
  // Calls running, alone or together, and a thought being written carry the status themselves.
  assert.deepEqual(end([user, running("a"), running("b")]), { status: false, block: 1, hidden: undefined, quietOnly: false, above: "work" });
  assert.equal(end([user, running("a")]).block, 1, "a lone call too");
  assert.equal(end([user, { kind: "thinking", text: "hm", open: true, started: 0, at: 0 }]).block, 1, "a thought being written");
  // Once they are done, the status stands on its own under them.
  assert.deepEqual(end([user, tool("bash", {}), { kind: "thinking", text: "hm", open: false, started: 0, at: 0 }]).status, true);
  // A retry being waited out is said by the status alone, which keeps the space it has under the message.
  assert.deepEqual(end([user, waiting]), { status: true, block: undefined, hidden: 1, quietOnly: false, above: "user" });
  assert.equal(end([user, { ...waiting, of: undefined, text: "retried once: …" } as Item]).hidden, undefined, "one the run went on from is drawn");
  // An answer being written is its own sign of life: the status only once it stops coming.
  assert.deepEqual(end([user, { kind: "assistant", text: "Here", open: true, at: 0 }]).quietOnly, true);
  assert.deepEqual(end([user, { kind: "assistant", text: "Here", open: false, at: 0 }]).quietOnly, false);
  // A sent message waiting to open the next turn sits between: nothing above it is the step.
  assert.deepEqual(end([user, running("a")], true, true), { status: true, block: undefined, hidden: undefined, quietOnly: false, above: "user" });
});

test("a place names the same line after a conversation is read back without the lines only this window showed", () => {
  const user = (entryId: string): Item => ({ kind: "user", text: entryId, entryId, at: 0 });
  const answer = (text: string): Item => ({ kind: "assistant", text, open: false, at: 0 });
  const ran: Item = { kind: "note", tone: "info", text: "ran /x", at: 0 };
  const live = group(lines([answer("before any message"), user("e1"), answer("a1"), ran, user("e2"), answer("a2"), user("e3"), answer("a3")]));
  const readBack = group(lines([answer("before any message"), user("e1"), answer("a1"), user("e2"), answer("a2"), user("e3"), answer("a3")]));

  const inA2 = placeAt(live, 5, -500);
  assert.equal((readBack[lineOf(readBack, inA2)!] as { text: string }).text, "a2", "the same answer, though a line above it is gone");
  assert.deepEqual(inA2, { turn: "e2", row: 1, offset: -500 }, "counted from the message that opened its turn");
  assert.equal(lineOf(live, inA2), 5, "and the same line where nothing changed");
  assert.equal(lineOf(readBack, placeAt(live, 7, 0)), 6, "the last line, which a count from the start would put past the end");
  assert.deepEqual(placeAt(live, 0, 10), { row: 0, offset: 10 }, "a line before the first message is counted from the start");
  assert.equal(lineOf(readBack, { turn: "gone", row: 0, offset: 0 }), undefined, "a place whose message is gone names no line");
});
