import assert from "node:assert/strict";
import { test } from "node:test";
import type { DuangApi, LoginOutcome, OpenResult, ProviderRow, Result } from "../preload/index.ts";
import { assistantEntry, deferred, empty, events, harness, listed, opened, panes, ready, runningSession, sessionOf } from "./store-harness.ts";

test("an agent's existing conversation opens straight into it, never by way of the new-conversation page", async () => {
  const { api, store } = harness();
  api.openAgent = async () => listed("s1");
  const history = deferred<ReturnType<typeof opened>>();
  api.openSession = () => history.promise;
  const { seen, stop } = panes(store);
  const loading = store.load();
  await new Promise((resolve) => setImmediate(resolve));
  history.resolve(opened([assistantEntry("a1", { text: "done" })], sessionOf("s1")));
  await loading;
  stop();
  assert.deepEqual(seen, ["no-agents", "settling", "transcript"], "the agent list, then the agent opening, then its conversation");
  store.dispose();
});


test("a new conversation is the start page, and the model being changed is said as that, not as opening", async () => {
  const { api, store } = harness();
  await store.load();
  assert.equal(store.getSnapshot().pane, "start", "an agent with no conversations starts a new one");
  const change = deferred<Result>();
  api.setModel = () => change.promise;
  const picking = store.pickModel("provider/other");
  assert.equal(store.getSnapshot().blocked, "changing the model…");
  assert.equal(store.getSnapshot().pane, "start", "the conversation stays on screen");
  change.resolve({ ok: true } as Result);
  await picking;
  assert.equal(store.getSnapshot().changingModel, undefined);
  assert.equal(store.getSnapshot().blocked, undefined);
  store.dispose();
});


test("a model change still running when the person goes to another agent does not hold that agent", async () => {
  const { api, store } = harness();
  await store.load();
  const change = deferred<Result>();
  api.setModel = () => change.promise;
  const picking = store.pickModel("provider/other");
  await store.selectAgent("b");
  assert.equal(store.getSnapshot().blocked, undefined, "b can be used while a's model is set up");
  change.resolve({ ok: true } as Result);
  await picking;
  await store.selectAgent("a");
  assert.equal(store.getSnapshot().blocked, undefined, "and a is not left changing for good");
  store.dispose();
});


test("an unreadable agent list is its own pane; a refused create returns its reason and an unexpected failure is said above the pane", async () => {
  const { api, store } = harness();
  api.listAgents = async () => {
    throw new Error("agents.json: Unexpected token");
  };
  await store.load();
  assert.equal(store.getSnapshot().pane, "unreadable-registry");
  assert.equal(store.getSnapshot().registryError, "agents.json: Unexpected token");
  assert.equal(store.getSnapshot().alert, undefined, "the page says it; nothing over it repeats it");

  api.listAgents = async () => [];
  await store.load();
  assert.equal(store.getSnapshot().pane, "no-agents");
  api.createAgent = async () => ({
    ok: false,
    error: { code: "invalid_agent", message: 'this agent already has content named "tally"', retryable: false },
  });
  assert.equal(await store.createAgent("Reviewer", ["/a/tally", "/b/tally"]), 'this agent already has content named "tally"');
  assert.equal(store.getSnapshot().failure, undefined, "a validation refusal belongs to the create form");

  api.createAgent = async () => {
    throw new Error("EACCES: permission denied, mkdir '/Users/someone/Agents'");
  };
  await store.createAgent("Reviewer", []);
  assert.equal(store.getSnapshot().pane, "no-agents", "creating failed; the list itself was read fine");
  assert.equal(store.getSnapshot().failure?.title, "The agent was not created");
  assert.match(store.getSnapshot().failure?.reason ?? "", /EACCES/);
  store.dismissFailure();
  assert.equal(store.getSnapshot().failure, undefined);
  store.dispose();
});


test("a setup problem is its own pane, and its prose is not repeated above it", async () => {
  const { api, store } = harness();
  api.openAgent = async () => ({ ok: false, code: "broken", message: "boom" });
  await store.load();
  assert.equal(store.getSnapshot().pane, "broken");
  assert.equal(store.getSnapshot().error, "boom", "the panel says it");
  assert.equal(store.getSnapshot().alert, undefined);
  api.openAgent = async () => ({ ok: false, code: "missing_dir", message: "ENOENT" });
  await store.selectAgent("b");
  assert.equal(store.getSnapshot().pane, "missing-dir");
  assert.equal(store.getSnapshot().alert, undefined);
  store.dispose();
});


test("an agent with no default opens on its latest conversation; only a new one with no model asks for one", async () => {
  const { api, store } = harness();
  // No default model: the agent opens all the same, and its conversation runs on the model it recorded.
  api.openAgent = async () => ({ ok: true, sessions: [{ session: "older", updatedAt: 5, preview: "hi" }], windows: {} });
  api.openSession = async (_id, session) =>
    opened([], sessionOf(session, session === "older" ? { model: { provider: "provider", modelId: "model" } } : {}));
  await store.load();
  assert.equal(store.getSnapshot().conversation?.session, "older", "straight to its history, no model asked for");
  assert.equal(store.getSnapshot().blocked, undefined);
  // A new conversation records no model and has no default to fall back on: it asks.
  await store.newConversation();
  const fresh = store.getSnapshot().conversation!;
  assert.notEqual(fresh.session, "older");
  assert.equal(store.getSnapshot().blocked, "pick a model to start");
  // Chosen there, it runs on it, and the page stays the one the model was chosen on.
  api.readState = async (_id, session) => sessionOf(session, { model: { provider: "provider", modelId: "model" } });
  api.openAgent = async () => listed("older");
  await store.pickModel("provider/model");
  assert.equal(store.getSnapshot().conversation, fresh);
  assert.equal(store.getSnapshot().blocked, undefined, "the one rule that disables the composer");
  store.dispose();
});


test("a store that React disposes and loads again still hears its conversations and sign-ins", async () => {
  // Fast Refresh re-runs the App effect's cleanup and setup on the same store; setup must register again.
  const { api, store, emit, step } = harness();
  await store.load();
  store.dispose();
  await store.load();
  const c = store.getSnapshot().conversation!;
  assert.equal(c.loading, false);
  emit(c, events.state(runningSession(c.session)));
  assert.equal(store.getSnapshot().busy, true, "the run FastAgent reported is shown as running");
  const provider: ProviderRow = { id: "p", name: "P", ways: [{ method: "api_key", label: "P key", subscription: false }] };
  const done = deferred<LoginOutcome>();
  api.login = () => done.promise;
  const connecting = store.connect(provider, provider.ways[0]!);
  step({ type: "prompt", id: "1", prompt: { type: "secret", message: "Key" } });
  assert.equal(store.getSnapshot().signIn?.prompt?.id, "1", "the flow's question reaches the sign-in");
  done.resolve({ ok: false, cancelled: true });
  await connecting;
  store.dispose();
});


test("late agent and conversation reads cannot replace the current selection", async () => {
  const { api, store } = harness();
  const agent = deferred<OpenResult>();
  api.openAgent = async (id) => (id === "a" ? agent.promise : ready);
  const old = store.selectAgent("a");
  await store.selectAgent("b");
  agent.resolve({ ok: false, code: "broken", message: "stale failure" });
  await old;
  assert.equal(store.getSnapshot().agentId, "b");
  assert.equal(store.getSnapshot().error, undefined);
  const snapshot = deferred<ReturnType<typeof empty>>();
  api.openSession = async (_id, session) => (session === "old" ? snapshot.promise : empty());
  const oldSession = store.open("old");
  await store.open("new");
  snapshot.resolve(empty());
  await oldSession;
  assert.equal(store.getSnapshot().conversation?.session, "new");
  store.dispose();
});


test("a restart reopens the agent and conversation the window was left on", async () => {
  const values = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => void values.set(k, v),
  };
  Object.defineProperty(globalThis, "localStorage", { value: localStorage, configurable: true });
  try {
    const first = harness();
    first.api.openAgent = async () => listed("kept");
    await first.store.load();
    await first.store.selectAgent("b");
    await first.store.open("kept");
    first.store.dispose();

    const second = harness();
    second.api.openAgent = async () => listed("kept");
    await second.store.load();
    assert.equal(second.store.getSnapshot().agentId, "b");
    assert.equal(second.store.getSnapshot().conversation?.session, "kept");
    second.store.setDraft("typed before quitting");
    second.store.dispose();

    // Unsent text survives the restart too, and stops existing once it is cleared.
    const third = harness();
    third.api.openAgent = async () => listed("kept");
    await third.store.load();
    assert.equal(third.store.getSnapshot().conversation?.draft, "typed before quitting");
    assert.deepEqual(third.store.getSnapshot().unsent["b"] ?? [], ["kept"]);
    third.store.setDraft("");
    third.store.dispose();

    const fourth = harness();
    fourth.api.openAgent = async () => listed("kept");
    await fourth.store.load();
    assert.equal(fourth.store.getSnapshot().conversation?.draft, "");
    assert.deepEqual(fourth.store.getSnapshot().unsent["b"] ?? [], []);
    fourth.store.dispose();
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});


test("a config that failed to load is offered afresh once, however often the button is pressed", async () => {
  const { api, store } = harness();
  api.openAgent = async () => ({ ok: false, code: "broken", message: "/p/fastagent/fastagent.config.ts: Expression expected", inConfig: true });
  await store.load();
  assert.equal(store.getSnapshot().errorInConfig, true, "main says the failure is in the config");
  const reset = deferred<Result>();
  let calls = 0;
  api.resetAgentConfig = () => (calls++, reset.promise);
  const first = store.resetConfig();
  const second = store.resetConfig();
  reset.resolve({ ok: true });
  await Promise.all([first, second]);
  assert.equal(calls, 1, "a double click is one reset");
  store.dispose();
});


test("the roster is first drawn in the avatar style already chosen, not the default and then that", async () => {
  const { api, store } = harness();
  const style = deferred<"moods">();
  api.getSettings = async () => ({ network: { mode: "automatic" }, avatar: await style.promise });
  const drawn: string[] = [];
  const stop = store.subscribe(() => {
    const view = store.getSnapshot();
    if (view.agents.length) drawn.push(view.avatar);
  });
  const loading = store.load();
  await new Promise((resolve) => setImmediate(resolve));
  style.resolve("moods");
  await loading;
  stop();
  assert.ok(drawn.length > 0, "the roster was drawn");
  assert.ok(drawn.every((avatar) => avatar === "moods"), `every drawing of the roster wore the chosen style: ${[...new Set(drawn)]}`);
  store.dispose();
});


test("an unreadable settings file leaves the default style and does not stop the roster", async () => {
  const { api, store } = harness();
  api.getSettings = async () => {
    throw new Error("settings.json: Unexpected token");
  };
  await store.load();
  assert.equal(store.getSnapshot().avatar, "gaze");
  assert.equal(store.getSnapshot().agents.length, 2, "the agents still load");
  store.dispose();
});


test("reveal opens the agent it is given, else the open one, and the registry when there is none", async () => {
  const { api, store } = harness();
  const revealed: string[] = [];
  const links: string[] = [];
  api.revealAgent = async (id, path) => void revealed.push(path ? `agent:${id}:${path}` : `agent:${id}`);
  api.revealRegistry = async () => void revealed.push("registry");
  api.openExternal = async (url) => void links.push(url);
  await store.load();
  await store.reveal("b");
  await store.reveal();
  await store.reveal("a", "src/main/index.ts:61");
  await store.openLink("https://fastagent.sh/docs");
  assert.deepEqual(
    revealed,
    ["agent:b", "agent:a", "agent:a:src/main/index.ts:61"],
    "a row's menu names its own agent; the header's default is the open one; a file path goes with its agent",
  );
  assert.deepEqual(links, ["https://fastagent.sh/docs"]);

  api.openExternal = async () => {
    throw new Error("Only http, https, and mailto links can be opened");
  };
  await store.openLink("javascript:alert(1)");
  assert.equal(store.getSnapshot().failure?.title, "The link could not be opened");
  store.dismissFailure();
  store.dispose();

  const empty = harness();
  empty.api.listAgents = async () => [];
  empty.api.revealAgent = async (id) => void revealed.push(`agent:${id}`);
  empty.api.revealRegistry = async () => void revealed.push("registry");
  await empty.store.load();
  revealed.length = 0;
  await empty.store.reveal();
  assert.deepEqual(revealed, ["registry"], "with no agent, the list itself is what there is to show");
  empty.store.dispose();
});


test("command names load once per agent, retry after a failure, and never cross agents", async () => {
  const { api, store } = harness();
  const commandCalls: string[] = [];
  api.listCommands = async (agentId) => {
    commandCalls.push(agentId);
    return [{ name: "plan", description: "", source: "definition" }];
  };
  await store.load();

  await store.loadCommands();
  await store.loadCommands();
  assert.deepEqual(commandCalls, ["a"], "the names are fetched once for this agent");
  assert.equal(store.getSnapshot().commands[0]?.name, "plan");

  await store.selectAgent("b");
  assert.deepEqual(store.getSnapshot().commands, [], "another agent has its own definition");
  api.listCommands = async (agentId) => {
    commandCalls.push(agentId);
    throw new Error("definition unreadable");
  };
  await store.loadCommands();
  assert.equal(store.getSnapshot().commandsError, "definition unreadable");
  api.listCommands = async (agentId) => {
    commandCalls.push(agentId);
    return [{ name: "review", description: "", source: "definition" }];
  };
  await store.loadCommands();
  assert.equal(store.getSnapshot().commands[0]?.name, "review", "a failed load must not lock the agent out");
  assert.deepEqual(commandCalls, ["a", "b", "b"]);

  // Switching away mid-flight: the late answer belongs to an agent nobody is looking at.
  const slow = deferred<{ name: string; description: string; source: string }[]>();
  await store.selectAgent("a");
  api.listCommands = () => slow.promise as ReturnType<DuangApi["listCommands"]>;
  const pending = store.loadCommands();
  await store.selectAgent("b");
  slow.resolve([{ name: "from-a", description: "", source: "definition" }]);
  await pending;
  assert.deepEqual(store.getSnapshot().commands, [], "an answer for the agent we left must not be shown");
  store.dispose();
});


test("the sidebar acts on the agent it names: listing and opening another agent's conversation", async () => {
  const { api, store, opens } = harness();
  api.openAgent = async (id) => (id === "b" ? listed("b-1") : ready);
  await store.load();
  assert.equal(store.getSnapshot().agentId, "a");

  await store.listSessions("b");
  assert.deepEqual(
    store.getSnapshot().sessions["b"]?.map((s) => s.session),
    ["b-1"],
  );
  assert.equal(store.getSnapshot().agentId, "a", "listing is not opening");

  // Clicking a conversation of another agent is one navigation that lands on that conversation.
  api.openAgent = async (id) => (id === "b" ? listed("b-2") : ready);
  await store.selectAgent("b", "b-2");
  assert.equal(store.getSnapshot().conversation?.agentId, "b");
  assert.equal(store.getSnapshot().conversation?.session, "b-2");
  assert.ok(opens.includes("b-2"));
  store.dispose();
});


test("an agent whose list cannot be read says why, on its own row", async () => {
  const { api, store } = harness();
  await store.load();
  const openConversation = store.getSnapshot().conversation!;
  api.openAgent = async (id) =>
    id === "b" ? { ok: false, code: "broken", message: "runtime would not start" } : ready;

  await store.listSessions("b");
  assert.equal(store.getSnapshot().sessionsError["b"], "runtime would not start");
  assert.equal(store.getSnapshot().states.b, "broken", "another agent's row says its setup in words");
  // A background re-read must not declare the open agent broken.
  api.openAgent = async () => ({ ok: false, code: "broken", message: "runtime would not start" });
  await store.listSessions("a");
  assert.equal(store.getSnapshot().states.a, "ready");
  assert.equal(
    openConversation.items.filter((item) => item.kind === "note").length,
    0,
    "another agent's failure never lands in the transcript being read",
  );

  // Asking again after the cause is fixed clears it, rather than caching the first answer forever.
  api.openAgent = async () => listed("b-1");
  await store.listSessions("b");
  assert.equal(store.getSnapshot().sessionsError["b"], undefined);
  assert.equal(store.getSnapshot().states.b, "ready");
  assert.deepEqual(
    store.getSnapshot().sessions["b"]?.map((s) => s.session),
    ["b-1"],
  );
  store.dispose();
});


test("a fresh start stays chosen across a reload or restart, until another conversation is opened", async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v) },
    configurable: true,
  });
  try {
    // `s1` is the newest conversation, the one that crashed the window.
    const first = harness();
    first.api.openAgent = async () => listed("s1");
    await first.store.load({ fresh: true });
    const started = first.store.getSnapshot().conversation!.session;
    first.store.dispose();

    const reloaded = harness();
    reloaded.api.openAgent = async () => listed("s1");
    await reloaded.store.load();
    assert.equal(reloaded.store.getSnapshot().conversation?.session, started, "not the newest, which crashed it");
    assert.ok(!reloaded.opens.includes("s1"));
    // Choosing the old one is the person's call, and from then on it is the one returned to.
    await reloaded.store.open("s1");
    reloaded.store.dispose();

    const later = harness();
    later.api.openAgent = async () => listed("s1");
    await later.store.load();
    assert.equal(later.store.getSnapshot().conversation?.session, "s1");
    later.store.dispose();
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});


test("a fresh start opens the agent on a new conversation, not the one it was left on", async () => {
  const { api, store, opens } = harness();
  api.openAgent = async () => listed("s1");
  await store.load({ fresh: true });
  const c = store.getSnapshot().conversation!;
  assert.notEqual(c.session, "s1");
  assert.ok(!opens.includes("s1"), "the conversation it crashed on is not opened");
  assert.equal(store.getSnapshot().pane, "start");
  store.dispose();
});
