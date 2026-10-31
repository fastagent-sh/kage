import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "@fastagent-sh/fastagent";
import { subscriptions, type Frame } from "./follow.ts";

const delta = (text: string): SessionEvent => ({ type: "delta", channel: "text", text });
const names = (frames: Frame[]) => frames.map((f) => (f.event?.type === "delta" ? f.event.text : f.event?.type ?? f.ended?.why));

function source(name: string, signal: AbortSignal) {
  const queue: (IteratorResult<SessionEvent> | Error)[] = [];
  let wake: (() => void) | undefined;
  const state = { aborted: false, after: "" };
  const push = (event: SessionEvent) => {
    queue.push({ value: event, done: false });
    wake?.();
  };
  const finish = () => {
    queue.push({ value: undefined, done: true });
    wake?.();
  };
  const fail = (error: Error) => {
    queue.push(error);
    wake?.();
  };
  signal.addEventListener("abort", () => {
    state.aborted = true;
    finish();
  });
  const stream: AsyncIterable<SessionEvent> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
        const item = queue.shift()!;
        if (item instanceof Error) throw item;
        return item;
      },
    }),
  };
  return { name, stream, push, finish, fail, state };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

function table() {
  const opened = new Map<string, ReturnType<typeof source>>();
  const gates = new Map<string, Promise<void>>();
  const subs = subscriptions(async (agentId, session, after, signal) => {
    await gates.get(`${agentId}/${session}`);
    const s = source(`${agentId}/${session}`, signal);
    s.state.after = after;
    opened.set(s.name, s);
    return s.stream;
  });
  const window = (id: number) => {
    const heard: Frame[] = [];
    return { id, heard, post: (frame: Frame) => heard.push(frame) };
  };
  return { subs, opened, gates, window };
}

test("a subscription's frames name it; the same id opened again replaces it, and the first falls silent", async () => {
  const { subs, opened, gates, window } = table();
  const w = window(1);
  await subs.open(w, "a", "s1", "sub", "e1");
  assert.equal(opened.get("a/s1")!.state.after, "e1", "it listens after the entry the window already holds");
  opened.get("a/s1")!.push(delta("one"));
  await tick();
  assert.deepEqual(w.heard, [{ agentId: "a", session: "s1", subscription: "sub", event: delta("one") }]);

  await subs.open(w, "a", "s2", "sub", "start");
  assert.equal(opened.get("a/s1")!.state.aborted, true);
  opened.get("a/s1")!.push(delta("late"));
  opened.get("a/s2")!.push(delta("two"));
  await tick();
  assert.deepEqual(names(w.heard), ["one", "two"]);

  let release!: () => void;
  gates.set("a/slow", new Promise((resolve) => (release = resolve)));
  const superseded = subs.open(w, "a", "slow", "other", "start");
  await subs.open(w, "a", "s3", "other", "start");
  release();
  await assert.rejects(superseded, /superseded/);
  opened.get("a/slow")!.push(delta("never heard"));
  await tick();
  assert.ok(!w.heard.some((f) => f.session === "slow"), "nothing of the superseded open is heard");
});

test("a window's subscriptions close with it, without an ending; other windows keep theirs", async () => {
  const { subs, opened, window } = table();
  const [w1, w2] = [window(1), window(2)];
  await subs.open(w1, "a", "s1", "x", "start");
  await subs.open(w2, "a", "s2", "x", "start");
  subs.closeWindow(1);
  assert.equal(opened.get("a/s1")!.state.aborted, true);
  assert.equal(opened.get("a/s2")!.state.aborted, false);
  opened.get("a/s2")!.push(delta("still"));
  await tick();
  assert.deepEqual(w1.heard, [], "closing is not news to the one who closed");
  assert.deepEqual(names(w2.heard), ["still"]);
});

test("removing an agent ends only its subscriptions, with the reason", async () => {
  const { subs, opened, window } = table();
  const w = window(1);
  await subs.open(w, "a", "s1", "x", "start");
  await subs.open(w, "b", "s2", "y", "start");
  subs.endAgent("a", "The agent was removed");
  assert.deepEqual(w.heard, [{ agentId: "a", session: "s1", subscription: "x", ended: { reason: "The agent was removed", why: "ended" } }]);
  assert.equal(opened.get("a/s1")!.state.aborted, true);
  opened.get("b/s2")!.push(delta("b lives"));
  await tick();
  assert.deepEqual(w.heard.at(-1), { agentId: "b", session: "s2", subscription: "y", event: delta("b lives") });
});

test("a stream that finishes on its own is a let-go, one that throws or reports an error is a failure", async () => {
  const { subs, opened, window } = table();
  const w = window(1);
  await subs.open(w, "a", "done", "1", "start");
  await subs.open(w, "a", "broken", "2", "start");
  await subs.open(w, "a", "reported", "3", "start");
  opened.get("a/done")!.finish();
  opened.get("a/broken")!.fail(new Error("socket reset"));
  opened.get("a/reported")!.push({ type: "stream_error", error: { code: "internal", message: "storage failed", retryable: false } });
  await tick();
  const endings = Object.fromEntries(w.heard.map((f) => [f.subscription, f.ended]));
  assert.deepEqual(endings, {
    "1": { reason: "This conversation stopped receiving updates", why: "let_go" },
    "2": { reason: "Error: socket reset", why: "failed" },
    "3": { reason: "storage failed", why: "failed" },
  });
});

test("a conversation that cannot be opened leaves nothing in the table", async () => {
  const subs = subscriptions(async () => {
    throw new Error("no such runtime");
  });
  await assert.rejects(subs.open({ id: 1, post: () => {} }, "a", "s", "x", "start"), /no such runtime/);
  assert.doesNotThrow(() => subs.endAgent("a", "gone"));
});
