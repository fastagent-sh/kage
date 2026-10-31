import assert from "node:assert/strict";
import { test } from "node:test";
import type { DuangApi, OpenResult } from "../preload/index.ts";
import { STOPPED_CODE } from "../shared/refusals.ts";
import { queueView } from "./transcript.ts";
import {
  assistantEntry,
  deferred,
  events,
  harness,
  listed,
  messageOf,
  opened,
  ready,
  resultEntry,
  runningSession,
  sessionOf,
  userEntry,
} from "./store-harness.ts";

type Sent = Awaited<ReturnType<DuangApi["send"]>>;
type Harness = ReturnType<typeof harness>;
type Open = NonNullable<ReturnType<Harness["store"]["getSnapshot"]>["conversation"]>;

const failure = (message: string, code = "model_error") =>
  ({ error: { code, message, retryable: false } }) as Partial<ReturnType<typeof messageOf>>;

// A person's message as FastAgent takes it: its user entry names the message it came from.
const take = (emit: Harness["emit"], c: Open, text: string, messageId: string, entryId = `u-${messageId}`) =>
  emit(c, events.entry(userEntry(entryId, text, messageId)));

// Each send is answered with the next message id, as FastAgent answers once it has recorded it.
function sender(h: Harness) {
  let n = 0;
  return async (text: string) => {
    const messageId = `m${++n}`;
    h.api.send = async () => ({ ok: true, messageId });
    h.store.setDraft(text);
    await h.store.send();
    return messageId;
  };
}

const said = (c: { items: { kind: string; text?: string; steered?: boolean }[] }) =>
  c.items.flatMap((item) =>
    item.kind === "user" ? [`${item.steered ? "joined" : "you"}:${item.text}`] : item.kind === "assistant" || item.kind === "note" ? [item.text!] : [],
  );

test("drafts stay with conversations; rejected sends preserve text and report the original error", async () => {
  const { api, store } = harness();
  await store.load();
  await store.open("one");
  store.setDraft("unsent first");
  await store.open("two");
  store.setDraft("unsent second");
  await store.open("one");
  assert.equal(store.getSnapshot().conversation?.draft, "unsent first");
  api.send = async () => {
    throw new Error("original IPC failure");
  };
  await store.send();
  const c = store.getSnapshot().conversation!;
  assert.equal(c.draft, "unsent first");
  assert.equal(store.getSnapshot().busy, false);
  assert.ok(
    c.items.every((item) => item.kind !== "user"),
    "a refused send must not look delivered",
  );
  assert.ok(c.items.some((item) => item.kind === "note" && item.text === "original IPC failure"));
  await store.open("two");
  assert.equal(store.getSnapshot().conversation?.draft, "unsent second");
  store.dispose();
});


test("a rejected send returns its text without eating what was typed meanwhile", async () => {
  const { api, store } = harness();
  await store.load();
  await store.open("one");
  const refusal = deferred<Sent>();
  api.send = () => refusal.promise;
  store.setDraft("first message");
  const sending = store.send();
  // The person does not wait for admission; they start the next line while it is still pending.
  store.setDraft("typed while waiting");
  refusal.resolve({ ok: false, error: { code: "refused", message: "no", retryable: true } });
  await sending;
  assert.equal(store.getSnapshot().conversation?.draft, "first message\ntyped while waiting");
  store.dispose();
});


test("unreadable drafts are moved aside, not overwritten by the next write", async () => {
  const values = new Map<string, string>([["duang.drafts", "{not json"]]);
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v) },
    configurable: true,
  });
  const error = console.error;
  console.error = () => {};
  try {
    const { store } = harness();
    await store.load();
    store.setDraft("new text");
    assert.equal(values.get("duang.drafts.unreadable"), "{not json", "the person's old text survives the write");
    assert.match(values.get("duang.drafts") ?? "", /new text/);
    store.dispose();
  } finally {
    console.error = error;
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});


test("a draft save failure is visible, keeps the text, and clears after storage recovers", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let failing = false;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem(key: string, value: string) {
        if (failing && key === "duang.drafts") throw new Error("storage full");
        values.set(key, value);
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const { store } = harness();
  t.after(store.dispose);
  await store.load();
  failing = true;
  store.setDraft("keep this text");
  assert.equal(store.getSnapshot().conversation?.draft, "keep this text");
  assert.match(store.getSnapshot().draftsError ?? "", /storage full/);
  failing = false;
  store.setDraft("keep this text");
  assert.equal(store.getSnapshot().draftsError, undefined);
  assert.match(values.get("duang.drafts") ?? "", /keep this text/);
});


test("an unsent conversation keeps a row, so leaving it is not discarding it", async () => {
  const { store } = harness();
  await store.load();
  await store.open("unsent");
  store.setDraft("typed but never sent");
  await store.selectAgent("b");
  // Per agent, so switching away does not hide it: it belongs to A's list, not to whatever is open.
  assert.deepEqual(store.getSnapshot().unsent, { a: ["unsent"] });
  await store.selectAgent("a");
  assert.deepEqual(store.getSnapshot().unsent["a"] ?? [], ["unsent"]);
  assert.equal(store.getSnapshot().conversation?.session, "unsent", "returning lands where you left");
  assert.equal(store.getSnapshot().conversation?.draft, "typed but never sent");
  store.setDraft("");
  await store.open("other");
  assert.deepEqual(store.getSnapshot().unsent["a"] ?? [], [], "an emptied draft leaves no row behind");
  store.dispose();
});


test("a failure is shown as the sentence main wrote, wherever it lands", async () => {
  const { api, store } = harness();
  await store.load();
  const wrapped = new Error("Error invoking remote method 'session:open': Error: no such session");
  api.openSession = async () => {
    throw wrapped;
  };
  await store.open("gone");
  assert.equal(store.getSnapshot().conversation?.error?.reason, "no such session");
  assert.equal(store.getSnapshot().alert?.title, "This conversation could not be opened");
  api.openSession = async (_id, session) => opened([], sessionOf(session));
  api.send = async () => {
    throw wrapped;
  };
  await store.retry();
  store.setDraft("hi");
  await store.send();
  const notes = store.getSnapshot().conversation?.items.filter((item) => item.kind === "note");
  const last = notes?.at(-1);
  assert.equal(last?.kind === "note" && last.reason, "no such session", "the strip and the transcript keep main's words");
  assert.equal(last?.kind === "note" && last.title, "The message could not be sent");
  store.dispose();
});


test("opening the conversation that is already open changes nothing", async () => {
  const { store, opens } = harness();
  await store.load();
  const c = store.getSnapshot().conversation!;
  const seen: unknown[] = [];
  const stop = store.subscribe(() => seen.push(store.getSnapshot().conversation));
  const opened = opens.length;
  await store.open(c.session);
  stop();
  assert.equal(store.getSnapshot().conversation, c, "the same conversation, not a rebuilt one");
  assert.ok(seen.every((shown) => shown === c), "the view is never cleared on the way, which would remount it");
  assert.equal(opens.length, opened, "and nothing is read again");
  store.dispose();
});


test("moving to another conversation never passes through having none", async () => {
  const { store, closed } = harness();
  await store.load();
  const first = store.getSnapshot().conversation!;
  const seen: unknown[] = [];
  const stop = store.subscribe(() => seen.push(store.getSnapshot().conversation));
  await store.open("another");
  stop();
  assert.ok(seen.length > 0, "the move was published");
  assert.ok(
    seen.every((shown) => shown !== undefined),
    "the view is never cleared on the way: that renders the screen for no conversation, for a frame",
  );
  assert.notEqual(store.getSnapshot().conversation, first);
  assert.ok(closed.includes(first.subscription), "and the one left is still closed, as soon as it is not the open one");
  store.dispose();
});


test("a refusal and a failure are different answers in the transcript", async () => {
  const { api, store } = harness();
  await store.load();
  const c = store.getSnapshot().conversation!;
  api.setModel = async () => ({
    ok: false,
    error: { code: "model_unavailable", message: "gpt-9 is not in the configured credential file", retryable: false },
  });
  api.abort = async () => ({ ok: false, error: { code: "failed", message: "the runtime crashed", retryable: true } });

  // Nothing ran, so this is refused: the model is unchanged and the person's text is still theirs.
  await store.pickModel("provider/gpt-9");
  // A request that did run and broke is a failure.
  await store.abort();

  assert.deepEqual(
    c.items.filter((item) => item.kind === "note").map((item) => [item.tone, item.text]),
    [
      ["warning", "gpt-9 is not in the configured credential file"],
      ["error", "the runtime crashed"],
    ],
  );
  store.dispose();
});


test("a conversation opened mid-run shows its unanswered calls as running, not stopped", async () => {
  const { api, store } = harness();
  const entries = [
    userEntry("u", "go", "m1"),
    assistantEntry("a", { toolCalls: [{ id: "t", name: "bash", args: {} }] }),
  ];
  api.openSession = async () => opened(entries, runningSession("s"));
  await store.load();
  const tool = store.getSnapshot().conversation!.items.find((item) => item.kind === "tool");
  assert.equal(tool?.kind === "tool" && tool.status, "running");
  assert.equal(tool?.kind === "tool" && tool.started, undefined, "when it began is not in history");
  assert.equal(store.getSnapshot().busy, true);
  store.dispose();
});


test("a new conversation is the agent's blank one when it has one, and a new one otherwise", async () => {
  const { api, store } = harness();
  const created: string[] = [];
  api.createSession = async () => {
    created.push("made");
    return `made-${created.length}`;
  };
  api.openAgent = async () => ({ ...ready, sessions: [{ session: "blank" }, { session: "old", updatedAt: 5, preview: "hi" }] });
  await store.load();
  assert.equal(store.getSnapshot().conversation?.session, "blank", "it opens on the newest, which has nothing said in it");
  await store.newConversation();
  assert.equal(store.getSnapshot().conversation?.session, "blank", "a blank one is not left behind for another");
  assert.deepEqual(created, []);
  api.openAgent = async () => listed("old");
  await store.listSessions("a");
  await store.newConversation();
  assert.equal(store.getSnapshot().conversation?.session, "made-1");
  assert.equal(store.getSnapshot().pane, "start");
  store.dispose();
});


test("background turns retain their stream and transcript, then release it after settlement", async () => {
  const { api, store, emit, closed, opens } = harness();
  await store.load();
  const c = store.getSnapshot().conversation!;
  const sent = deferred<Sent>();
  api.send = () => sent.promise;
  store.setDraft("hello");
  const sending = store.send();
  sent.resolve({ ok: true, messageId: "m1" });
  await sending;
  take(emit, c, "hello", "m1");
  await store.newConversation();
  assert.deepEqual(store.getSnapshot().running["a"] ?? [], [c.session], "the running conversation is named under its agent");
  assert.equal(closed.includes(c.subscription), false);
  emit(c, events.delta("background answer"));
  const count = opens.length;
  await store.open(c.session);
  assert.equal(opens.length, count, "a live view is reused, not backfilled over its own deltas");
  assert.ok(c.items.some((item) => item.kind === "assistant" && item.text === "background answer"));
  emit(c, events.entry(assistantEntry("a1", { text: "background answer" })));
  emit(c, events.done(messageOf("m1", "completed", { entryId: "u-m1" })));
  assert.equal(c.state?.status, "idle");
  assert.equal(store.getSnapshot().busy, false);
  await store.newConversation();
  assert.ok(closed.includes(c.subscription), "an idle conversation nobody is looking at releases its stream");
  store.dispose();
});


test("a send still being recorded keeps its subscription though the message already ended", async () => {
  const { api, store, emit, closed } = harness();
  await store.load();
  const c = store.getSnapshot().conversation!;
  const sent = deferred<Sent>();
  api.send = () => sent.promise;
  store.setDraft("hello");
  const sending = store.send();
  await store.newConversation();
  take(emit, c, "hello", "m1");
  emit(c, events.entry(assistantEntry("a1", { text: "hi" })));
  emit(c, events.done(messageOf("m1", "completed")));
  assert.equal(closed.includes(c.subscription), false, "the answer to the send has not come back yet");
  sent.resolve({ ok: true, messageId: "m1" });
  await sending;
  assert.deepEqual(said(c), ["you:hello", "hi"], "placed once, whichever of the entry and the answer came first");
  assert.deepEqual(c.waiting, []);
  await store.newConversation();
  assert.ok(closed.includes(c.subscription));
  store.dispose();
});


test("settlement in another agent cannot invalidate the visible agent's list refresh", async () => {
  const { api, store, emit } = harness();
  await store.load();
  const a = store.getSnapshot().conversation!;
  emit(a, events.state(runningSession(a.session)));
  await store.selectAgent("b");
  const b = store.getSnapshot().conversation!;
  const refreshed = deferred<OpenResult>();
  api.openAgent = async (id) => (id === "b" ? refreshed.promise : ready);
  emit(b, events.done(messageOf("mb", "completed")));
  emit(a, events.done(messageOf("ma", "completed")));
  refreshed.resolve({ ...ready, sessions: [{ session: "b-saved", updatedAt: 1, preview: "B's turn" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getSnapshot().sessions["b"]?.[0]?.session, "b-saved");
  store.dispose();
});


test("a failed stop remains visible; a stale stream never changes a reopened session", async () => {
  const { api, store, emit, end, opens } = harness();
  await store.load();
  const old = store.getSnapshot().conversation!;
  api.abort = async () => ({ ok: false, error: { code: "busy", message: "FastAgent refused", retryable: true } });
  await store.abort();
  assert.ok(old.items.some((item) => item.kind === "note" && item.text === "FastAgent refused"));
  await store.retry(); // closes the subscription and opens the conversation again
  const current = store.getSnapshot().conversation!;
  emit(old, events.delta("stale"));
  assert.deepEqual(current.items, []);
  emit(current, events.entry(userEntry("u1", "go", "m1")));
  emit(current, events.entry(assistantEntry("a1", { toolCalls: [{ id: "t", name: "bash", args: {} }] })));
  emit(current, events.toolStarted("t"));
  assert.equal(store.getSnapshot().busy, true);
  // A failed stream waits for the person, and the run controls must not wait for the message's end.
  const reopened = opens.length;
  end(current, "stream disconnected", "failed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opens.length, reopened, "only a stream that finished by itself is listened to again by itself");
  assert.equal(store.getSnapshot().busy, false);
  const tool = store.getSnapshot().conversation!.items.find((item) => item.kind === "tool");
  assert.equal(tool?.kind === "tool" && tool.status, "interrupted", "a tool nobody is watching any more is not shown as running");
  store.setDraft("keep me");
  assert.equal(store.getSnapshot().blocked, "reconnect before sending");
  await assert.rejects(() => store.send(), /reconnect before sending/, "a blocked send is a bug, not a no-op");
  assert.equal(current.draft, "keep me");
  assert.equal(current.error?.reason, "stream disconnected");
  assert.equal(current.error?.title, "The live connection to this conversation was lost");
  await store.retry();
  assert.equal(store.getSnapshot().conversation?.draft, "keep me");
  assert.equal(store.getSnapshot().conversation?.error, undefined);
  store.dispose();
});


test("a stream that finished by itself is listened to again once; any other end is said", async () => {
  const { store, emit, end, opens } = harness();
  await store.load();
  const reopened = opens.length;
  end(store.getSnapshot().conversation!, "This conversation stopped receiving updates", "let_go");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opens.length, reopened + 1, "listened to again, from the entries already read");
  const c = store.getSnapshot().conversation!;
  assert.equal(c.ended, undefined, "and nothing is said about it");
  emit(c, events.state(runningSession(c.session)));
  end(c, "This conversation stopped receiving updates", "let_go");
  assert.equal(opens.length, reopened + 1, "not reconnected in a loop");
  const current = store.getSnapshot().conversation!;
  assert.equal(current.ended, "This conversation stopped receiving updates");
  assert.equal(current.error, undefined, "an intended end is not a failure");
  assert.ok(current.items.every((item) => item.kind !== "note"), "and it does not write itself into the transcript");
  assert.equal(store.getSnapshot().busy, false, "a deaf view must stop waiting for the message's end");
  store.setDraft("blocked");
  assert.equal(store.getSnapshot().blocked, "reconnect before sending");
  await assert.rejects(() => store.send(), /reconnect before sending/);
  assert.equal(current.draft, "blocked", "sending waits for the reconnect");
  await store.retry();
  assert.equal(store.getSnapshot().conversation?.ended, undefined);

  // duang ending it (the agent was removed) is not answered by opening it again.
  const before = opens.length;
  end(store.getSnapshot().conversation!, "The agent was removed", "ended");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opens.length, before, "a removed agent is not reopened");
  assert.equal(store.getSnapshot().conversation?.ended, "The agent was removed");
  store.dispose();

  // Nor while a send is still answering: a refusal puts its words back in the composer that reopening replaces.
  const second = harness();
  await second.store.load();
  const sent = deferred<Sent>();
  second.api.send = () => sent.promise;
  second.store.setDraft("my message");
  const sending = second.store.send();
  const waiting = second.opens.length;
  second.end(second.store.getSnapshot().conversation!, "This conversation stopped receiving updates", "let_go");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.opens.length, waiting, "not reopened under a send");
  sent.resolve({ ok: false, error: { code: "busy", message: "FastAgent refused", retryable: true } });
  await sending;
  assert.equal(second.store.getSnapshot().conversation?.draft, "my message", "the refused words are where the person sees them");
  second.store.dispose();
});


test("where a conversation was left above the latest line is remembered until its agent is gone", async () => {
  const { store } = harness();
  await store.load();
  const c = store.getSnapshot().conversation!;
  assert.equal(store.scrollOf(c.agentId, c.session), undefined, "a conversation opens at its latest line");
  store.rememberScroll(c.agentId, c.session, { turn: "e-12", row: 1, offset: -30 });
  store.rememberScroll("b", "b-1", { turn: "e-3", row: 0, offset: 0 });
  assert.deepEqual(store.scrollOf(c.agentId, c.session), { turn: "e-12", row: 1, offset: -30 });
  assert.deepEqual(store.scrollOf("b", "b-1"), { turn: "e-3", row: 0, offset: 0 }, "each conversation has its own place");
  store.rememberScroll(c.agentId, c.session, undefined);
  assert.equal(store.scrollOf(c.agentId, c.session), undefined, "scrolling back to the latest line forgets it");

  store.rememberScroll("a", "later", { row: 1, offset: 0 });
  await store.removeAgent();
  assert.equal(store.scrollOf("a", "later"), undefined, "a removed agent leaves none behind");
  assert.deepEqual(store.scrollOf("b", "b-1"), { turn: "e-3", row: 0, offset: 0 }, "another agent's places are not touched");
  store.dispose();
});


test("what finished while you were elsewhere is marked, and opening it spends the mark", async () => {
  const { store, emit } = harness();
  await store.load();
  const background = store.getSnapshot().conversation!;
  emit(background, events.state(runningSession(background.session)));
  await store.newConversation();
  assert.notEqual(store.getSnapshot().conversation, background, "the run is now in the background");

  emit(background, events.done(messageOf("m1", "completed")));
  assert.deepEqual(store.getSnapshot().unseen["a"], { [background.session]: "done" }, "an outcome you missed is kept");

  await store.open(background.session);
  assert.deepEqual(store.getSnapshot().unseen["a"] ?? {}, {}, "looking at it is what spends the mark");

  // A failure you missed is kept as a failure; one you were watching needs no mark at all.
  const other = store.getSnapshot().conversation!;
  emit(other, events.state(runningSession(other.session)));
  emit(other, events.done(messageOf("m2", "failed", failure("boom"))));
  assert.deepEqual(store.getSnapshot().unseen["a"] ?? {}, {}, "a run you watched end is not news");

  // Only a message in flight keeps an unwatched conversation alive, so the run starts before leaving.
  emit(other, events.state(runningSession(other.session)));
  await store.newConversation();
  emit(other, events.done(messageOf("m3", "failed", failure("boom"))));
  assert.deepEqual(store.getSnapshot().unseen["a"], { [other.session]: "failed" });

  // Stopping a run yourself is a decision, not something to come back to.
  const third = store.getSnapshot().conversation!;
  emit(third, events.state(runningSession(third.session)));
  await store.open(other.session);
  emit(third, events.done(messageOf("m4", "canceled")));
  assert.equal(store.getSnapshot().unseen["a"]?.[third.session], undefined, "a stop is not unseen news");
  store.dispose();
});


test("a message is placed where FastAgent says it entered, and joins only a run that already had one", async () => {
  const h = harness();
  const { store, emit } = h;
  const send = sender(h);
  await store.load();
  const c = store.getSnapshot().conversation!;
  const m1 = await send("start");
  assert.deepEqual(said(c), [], "sent, not yet in the conversation");
  assert.deepEqual(c.waiting.map((item) => [item.text, item.opens]), [["start", true]], "from idle, it opens the run");
  assert.equal(store.getSnapshot().busy, true, "FastAgent holds it: the conversation is at work");
  take(emit, c, "start", m1);
  assert.equal(c.waiting.length, 0);
  assert.equal(c.state?.status, "running", "a message taken starts the run");
  emit(c, events.delta("on the old plan"));

  // A steer waits below the output: the model keeps working without it until its next step.
  const m2 = await send("wait");
  assert.equal(c.waiting[0]?.opens, false, "a run that has its message is joined");
  assert.deepEqual(queueView(c.waiting).map(({ item, listed }) => [item.text, listed]), [["wait", true]]);
  emit(c, events.entry(assistantEntry("a1", { text: "on the old plan", toolCalls: [{ id: "t", name: "bash", args: {} }] })));
  emit(c, events.entry(resultEntry("r1", "t")));
  take(emit, c, "wait", m2);
  emit(c, events.delta("stopping"));
  assert.deepEqual(said(c), ["you:start", "on the old plan", "joined:wait", "stopping"]);
  assert.equal(c.waiting.length, 0);

  // A message sent from another window is placed when it is taken, not claimed by anything here.
  take(emit, c, "from elsewhere", "other-1");
  assert.equal(said(c).at(-2), "you:from elsewhere");
  assert.equal(c.items.filter((item) => item.kind === "user" && item.steered).length, 1);

  // Walking away and back during the run keeps a waiting message on screen.
  const m3 = await send("later");
  await store.newConversation();
  await store.open(c.session);
  assert.equal(store.getSnapshot().conversation, c, "a running conversation is reused, not reloaded");
  assert.deepEqual(c.waiting.map((item) => item.text), ["later"]);
  take(emit, c, "later", m3);
  emit(c, events.done(messageOf(m3, "completed")));
  assert.equal(c.state?.status, "idle");
  store.dispose();
});


test("a message still queued when the run is stopped returns to the draft, and one that was never taken says why", async () => {
  const h = harness();
  const { store, emit } = h;
  const send = sender(h);
  await store.load();
  const c = store.getSnapshot().conversation!;
  const m1 = await send("start");
  take(emit, c, "start", m1);

  const late = await send("too late");
  // Stop cancels everything queued, then the message that was running.
  emit(c, events.done(messageOf(late, "canceled")));
  assert.equal(said(c).includes("joined:too late"), false, "never shown as delivered");
  assert.equal(c.waiting.length, 0);
  assert.equal(c.draft, "too late", "it never entered, so it is the person's again");
  assert.equal(c.items.some((item) => item.kind === "note" && item.tone === "warning"), false, "a stop is not a refusal to explain");
  emit(c, events.done(messageOf(m1, "canceled")));
  assert.equal(said(c).at(-1), "run stopped");
  assert.equal(store.getSnapshot().resend, undefined, "a stop is not offered again");

  // A message FastAgent recorded and then failed without taking it: not sent, and it says why.
  c.draft = "";
  const refused = await send("no model");
  emit(c, events.done(messageOf(refused, "failed", failure("The session names no model", "missing_model"))));
  assert.equal(c.draft, "no model");
  const note = c.items.at(-1);
  assert.deepEqual(note?.kind === "note" && [note.tone, note.title, note.reason], ["warning", "Not sent", "The session names no model"]);
  store.dispose();
});


test("a refused first message returns to the draft, and one sent after it opens its own run above its answer", async () => {
  const { api, store, emit } = harness();
  await store.load();
  const c = store.getSnapshot().conversation!;
  const first = deferred<Sent>();
  api.send = () => first.promise;
  store.setDraft("A");
  const sending = store.send();
  const second = deferred<Sent>();
  api.send = () => second.promise;
  store.setDraft("B");
  const sendingB = store.send();
  first.resolve({ ok: false, error: { code: "busy", message: "no", retryable: false } });
  await sending;
  assert.equal(c.draft, "A");
  second.resolve({ ok: true, messageId: "m-b" });
  await sendingB;
  take(emit, c, "B", "m-b");
  emit(c, events.delta("answer to B"));
  assert.deepEqual(said(c), ["no", "you:B", "answer to B"]);
  emit(c, events.entry(assistantEntry("a1", { text: "answer to B" })));
  emit(c, events.done(messageOf("m-b", "completed")));
  store.dispose();
});


test("a message that overlapped the history read is not added twice", async () => {
  const { api, store, emit } = harness();
  const history = deferred<ReturnType<typeof opened>>();
  api.openSession = () => history.promise;
  const loading = store.load();
  await new Promise((resolve) => setImmediate(resolve));
  const c = store.getSnapshot().conversation!;
  assert.equal(c.loading, true);
  // Replayed by the stream, and already in the history read: the entry's id says so.
  take(emit, c, "opening", "m1", "u1");
  emit(c, events.delta("working"));
  history.resolve(opened([userEntry("u1", "opening", "m1")], runningSession("s")));
  await loading;
  assert.deepEqual(said(c), ["you:opening", "working"]);
  store.dispose();
});


test("a message sent to start a turn is what the row quotes at once, not the failure before it", async () => {
  const { api, store, emit } = harness();
  await store.load();
  const c = store.getSnapshot().conversation!;
  take(emit, c, "first try", "m1");
  emit(c, events.done(messageOf("m1", "failed", failure("OpenAI API error (529): overloaded"))));
  assert.equal(store.getSnapshot().previews["a"]?.text, "The provider had a problem");
  const sent = deferred<Sent>();
  api.send = () => sent.promise;
  store.setDraft("try again please");
  const sending = store.send();
  assert.equal(store.getSnapshot().previews["a"]?.text, "You: try again please", "before FastAgent reports it");
  sent.resolve({ ok: true, messageId: "m2" });
  await sending;
  store.dispose();
});


test("the open agent's list keeps the newest answer, and a failed re-read lands on its row", async () => {
  const { api, store, emit } = harness();
  api.openAgent = async () => listed("s1");
  await store.load();
  const c = store.getSnapshot().conversation!;
  const older = deferred<OpenResult>();
  const newer = deferred<OpenResult>();
  const answers = [older.promise, newer.promise];
  api.openAgent = () => answers.shift()!;
  // A read of the list is out; a message ending while it is re-reads it again.
  const relisted = store.listSessions("a");
  take(emit, c, "go", "m1");
  emit(c, events.done(messageOf("m1", "completed")));
  newer.resolve({ ...ready, sessions: [{ session: "s1", updatedAt: 9, preview: "Newest" }] });
  await new Promise((resolve) => setImmediate(resolve));
  older.resolve(listed("s1"));
  await relisted;
  assert.equal(store.getSnapshot().sessions["a"]?.[0]?.preview, "Newest", "the slower, older answer does not win");

  api.openAgent = async () => ({ ok: false, code: "broken", message: "runtime gone" });
  take(emit, c, "again", "m2");
  emit(c, events.done(messageOf("m2", "completed")));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getSnapshot().sessionsError["a"], "runtime gone");
  assert.ok(!c.items.some((item) => item.kind === "note" && item.text === "runtime gone"), "said on the row, once");
  store.dispose();
});


test("a roster row quotes the newest output of the conversation it speaks for, live while it streams", async () => {
  const { api, store, emit } = harness();
  const reads: string[][] = [];
  api.openAgent = async (id) => (id === "b" ? listed("b-1") : ready);
  api.readSession = async (id, session) => {
    reads.push([id, session]);
    return [{ ...assistantEntry("e1", { text: "B finished the report." }), timestamp: 7 }];
  };
  await store.load();
  await new Promise((resolve) => setImmediate(resolve));
  // B is not open, so its row reads the history of the conversation a click would show, once.
  assert.deepEqual(reads, [["b", "b-1"]]);
  assert.deepEqual(store.getSnapshot().previews["b"], { session: "b-1", text: "B finished the report.", at: 7 });
  await store.listSessions("b");
  assert.equal(reads.length, 1, "a conversation that has not moved on is not read again");

  // The open agent's row follows its conversation as it streams, with no read at all.
  const a = store.getSnapshot().conversation!;
  emit(a, events.state(runningSession(a.session)));
  emit(a, events.delta("Working on"));
  assert.equal(store.getSnapshot().previews["a"]?.text, "Working on");
  emit(a, events.delta(" it"));
  assert.equal(store.getSnapshot().previews["a"]?.text, "Working on it");
  assert.ok(!reads.some(([id]) => id === "a"));

  // A failed read says so on the row instead of quoting something older.
  api.openAgent = async (id) => (id === "b" ? listed("b-2") : ready);
  api.readSession = async () => {
    throw new Error("history unreadable");
  };
  await store.listSessions("b");
  assert.deepEqual(store.getSnapshot().previews["b"], { session: "b-2", error: "history unreadable" });
  store.dispose();
});


test("the conversation a row quotes is the one a click opens, even one only unsent text still keeps alive", async () => {
  const { api, store } = harness();
  api.openAgent = async (id) => (id === "b" ? listed("b-newest") : ready);
  api.createSession = async () => "unborn";
  await store.load();
  await store.selectAgent("b");
  await store.newConversation();
  assert.equal(store.getSnapshot().conversation?.session, "unborn");
  store.setDraft("still unsent");
  await store.selectAgent("a");
  // The list FastAgent gave does not hold it, and this window released it: the unsent text keeps it the one to open.
  assert.equal(store.getSnapshot().sessions["b"]?.some((s) => s.session === "unborn"), false);
  assert.equal(store.sessionFor("b"), "unborn");
  await store.selectAgent("b");
  assert.equal(store.getSnapshot().conversation?.session, "unborn", "a click opens the conversation the row quoted");
  assert.equal(store.getSnapshot().conversation?.draft, "still unsent");
  store.dispose();
});


test("a slow history read cannot replace a newer one", async () => {
  const { api, store } = harness();
  const at = (updatedAt: number) => ({ ...ready, sessions: [{ session: "b-1", updatedAt, preview: "x" }] }) as OpenResult;
  const reply = (text: string) => [assistantEntry(text, { text })];
  const slow = deferred<ReturnType<typeof reply>>();
  api.openAgent = async (id) => (id === "b" ? at(1) : ready);
  api.readSession = () => slow.promise;
  await store.load();
  api.openAgent = async (id) => (id === "b" ? at(2) : ready);
  api.readSession = async () => reply("newer");
  await store.listSessions("b");
  slow.resolve(reply("older"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getSnapshot().previews["b"]?.text, "newer");
  store.dispose();
});


test("Stop before the message reaches FastAgent returns it to the draft quietly; Stop with nothing running says nothing", async () => {
  const { api, store } = harness();
  await store.load();
  const c = store.getSnapshot().conversation!;
  const sent = deferred<Sent>();
  api.send = () => sent.promise;
  api.abort = async () => {
    // main marks the send it still holds as stopped, and that send gives up before recording anything
    sent.resolve({ ok: false, error: { code: STOPPED_CODE, message: "Stopped before the message was sent", retryable: true } });
    return { ok: true };
  };
  store.setDraft("hello");
  const sending = store.send();
  assert.equal(store.getSnapshot().busy, true, "Stop is offered at once");
  await store.abort();
  await sending;
  assert.equal(c.draft, "hello");
  assert.deepEqual(c.waiting, []);
  assert.equal(store.getSnapshot().busy, false);
  assert.deepEqual(c.items, [], "neither Stop is reported as a failure");
  api.abort = async () => ({ ok: true });
  await store.abort();
  assert.deepEqual(c.items, []);
  store.dispose();
});


test("a turn that failed after taking its message can be sent again; a failure before it, or a stop, cannot", async () => {
  const h = harness();
  const { api, store, emit } = h;
  await store.load();
  const c = store.getSnapshot().conversation!;
  const texts: string[] = [];
  let n = 0;
  api.send = async (_id, _session, text) => {
    texts.push(text);
    return { ok: true, messageId: `m${++n}` };
  };

  store.setDraft("summarise it");
  await store.send();
  take(emit, c, "summarise it", "m1");
  assert.equal(store.getSnapshot().resend, undefined, "not while it runs");
  emit(c, events.done(messageOf("m1", "failed", failure("Connection error."))));
  assert.deepEqual(store.getSnapshot().resend, { text: "summarise it", toolsRan: false });

  store.setDraft("half-typed");
  await store.resend();
  assert.equal(store.getSnapshot().resend, undefined, "one retry at a time");
  take(emit, c, "summarise it", "m2");
  emit(c, events.entry(assistantEntry("a2", { text: "Here it is" })));
  emit(c, events.done(messageOf("m2", "completed")));
  assert.deepEqual(texts, ["summarise it", "summarise it"]);
  assert.equal(c.draft, "half-typed", "the draft is not Retry's");
  assert.deepEqual(
    c.items.map((item) => item.kind),
    ["user", "note", "user", "assistant"],
    "the failure stays where it happened, and the message is sent as a new turn",
  );
  assert.equal(store.getSnapshot().resend, undefined, "a turn that completed has nothing to retry");

  // A run the person stopped is not offered again.
  store.setDraft("stop me");
  await store.send();
  take(emit, c, "stop me", "m3");
  emit(c, events.done(messageOf("m3", "canceled")));
  assert.equal(store.getSnapshot().resend, undefined);
  store.dispose();
});


test("Retry sends the message the turn was answering, and knows the tools it started", async () => {
  const { store, emit } = harness();
  await store.load();
  const c = store.getSnapshot().conversation!;
  take(emit, c, "fix the build", "m1");
  emit(c, events.entry(assistantEntry("a1", { toolCalls: [{ id: "t1", name: "bash", args: {} }] })));
  emit(c, events.entry(resultEntry("r1", "t1")));
  take(emit, c, "and push it", "m2");
  emit(c, events.entry(assistantEntry("a2", { stop: "failed", error: "Connection error." })));
  emit(c, events.done(messageOf("m1", "completed")));
  emit(c, events.done(messageOf("m2", "failed", failure("Connection error."))));
  assert.deepEqual(store.getSnapshot().resend, { text: "and push it", toolsRan: true });
  store.dispose();
});


test("a run that failed while the person was elsewhere shows its failure, and Retry, when they come back", async () => {
  const { api, store, emit } = harness();
  await store.load();
  const c = store.getSnapshot().conversation!;
  api.send = async () => ({ ok: true, messageId: "m1" });
  store.setDraft("hello");
  await store.send();
  take(emit, c, "hello", "m1", "u1");
  await store.selectAgent("b");
  emit(c, events.done(messageOf("m1", "failed", { error: { code: "model_error", message: "Connection error.", retryable: true } })));
  const message = messageOf("m1", "failed", { error: { code: "model_error", message: "Connection error.", retryable: true } });
  api.openSession = async (_id, session) => opened([userEntry("u1", "hello", "m1")], sessionOf(session), message);
  await store.selectAgent("a");
  const back = store.getSnapshot().conversation!;
  assert.notEqual(back, c, "read back from history, not the view that was let go");
  const last = back.items.at(-1);
  assert.equal(last?.kind === "note" && last.text, "run failed: Connection error.");
  assert.deepEqual(store.getSnapshot().resend, { text: "hello", toolsRan: false });
  store.dispose();
});


test("an agent's row does not call a conversation cut short while its run is still going", async () => {
  for (const running of [true, false]) {
    const { api, store } = harness();
    api.openAgent = async (id) => (id === "b" ? listed("b1") : ready);
    api.readSession = async () => [userEntry("u1", "fix the build", "m1")];
    api.readState = async (_id, session) => (running ? runningSession(session) : sessionOf(session));
    await store.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      store.getSnapshot().previews["b"]?.text,
      running ? "You: fix the build" : "This run was cut short",
      running ? "running" : "idle",
    );
    store.dispose();
  }
});


test("a refusal said before is said again, each send saying how it ended", async () => {
  const { api, store } = harness();
  await store.load();
  const c = store.getSnapshot().conversation!;
  const busy = { ok: false as const, error: { code: "agent_changing", message: "Agent settings are changing; try again.", retryable: true } };
  api.send = async () => busy;
  for (const text of ["first", "second"]) {
    store.setDraft(text);
    await store.send();
  }
  const refusals = c.items.filter((item) => item.kind === "note" && item.reason === busy.error.message);
  assert.equal(refusals.length, 2);
  assert.ok(refusals.every((item) => item.kind === "note" && item.title === "Not sent"));
  assert.equal(c.draft, "second", "and the refused message is back in the draft");
  store.dispose();
});


test("the model's silence counts from its own output: a steer, or the person's message entering, does not reset it", async () => {
  const h = harness();
  const { store, emit } = h;
  const send = sender(h);
  await store.load();
  const c = store.getSnapshot().conversation!;
  const m1 = await send("start");
  assert.ok(c.heard !== undefined, "a new run counts from its message");
  take(emit, c, "start", m1);
  const quietSince = c.heard!;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const m2 = await send("are you stuck?");
  take(emit, c, "are you stuck?", m2);
  assert.equal(c.heard, quietSince, "the person's own steer is not the model answering");
  emit(c, events.delta("no"));
  assert.ok(c.heard! > quietSince, "the model's output is");
  store.dispose();
});
