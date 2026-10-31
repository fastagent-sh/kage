import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentError, type Agent, type Message, type Session } from "@fastagent-sh/fastagent";
import { send, sends } from "./send.ts";
import { runningSessions, stopRuns } from "./runs.ts";

const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };

function fake(options: { session?: Partial<Session>; reject?: AgentError } = {}) {
  const calls: string[] = [];
  const agent = {
    info: async () => ({ defaultModel: model }),
    sessions: {
      get: async () => ({ id: "s", status: "idle", usage: {}, ...options.session }) as Session,
      update: async (_id: string, changes: { model?: { provider: string; modelId: string } }) => {
        calls.push(`update:${changes.model?.provider}/${changes.model?.modelId}`);
        return {} as Session;
      },
      cancel: async () => {
        calls.push("cancel");
        return { stopped: [] };
      },
    },
    messages: {
      send: async (request: { content: unknown; whenBusy?: string }) => {
        calls.push(`send:${request.content}:${request.whenBusy}`);
        if (options.reject) throw options.reject;
        return { id: "m1", sessionId: "s", status: "queued" } as Message;
      },
    },
  } as unknown as Agent;
  return { agent, calls };
}

test("a message is sent verbatim as a steer, so an idle conversation starts on it and a busy one is joined", async () => {
  const { agent, calls } = fake();
  const result = await send(agent, "s", "/commit verbatim", () => false, async () => true);
  assert.deepEqual(calls, ["send:/commit verbatim:steer"]);
  assert.deepEqual(result, { ok: true, messageId: "m1" });
});

test("a refusal from FastAgent keeps its code and words; any other failure is not turned into one", async () => {
  const busy = fake({ reject: new AgentError({ code: "busy", message: "the queue is full", retryable: true }) });
  const refused = await send(busy.agent, "s", "hi", () => false, async () => true);
  assert.deepEqual(refused, { ok: false, error: { code: "busy", message: "the queue is full", retryable: true } });

  const broken = fake();
  (broken.agent.messages as { send: unknown }).send = async () => {
    throw new TypeError("not a refusal");
  };
  await assert.rejects(send(broken.agent, "s", "hi", () => false, async () => true), /not a refusal/);
});

test("a message goes only to a model the picker would offer, before anything is recorded", async () => {
  const own = fake({ session: { model } });
  const refused = await send(own.agent, "s", "hello", () => false, async () => false);
  assert.deepEqual(own.calls, []);
  assert.equal(!refused.ok && refused.error.code, "model_unavailable");
  assert.match(!refused.ok ? refused.error.message : "", /^anthropic\/claude-sonnet-4-5 cannot run: .*Connect the provider/);

  const asked: string[] = [];
  const inherited = fake();
  await send(inherited.agent, "s", "hello", () => false, async (spec) => (asked.push(spec), true));
  assert.deepEqual(asked, ["anthropic/claude-sonnet-4-5"], "with no default of duang's, a conversation runs on the config's");
  assert.deepEqual(inherited.calls, ["send:hello:steer"]);
});

test("a conversation with no model of its own is given duang's default for the agent, and refused if that cannot run", async () => {
  const given = fake();
  const asked: string[] = [];
  await send(given.agent, "s", "hello", () => false, async (spec) => (asked.push(spec), true), "openai/gpt-5.5");
  assert.deepEqual(asked, ["openai/gpt-5.5"], "the default it will run on is the one checked, not the config's");
  assert.deepEqual(given.calls, ["update:openai/gpt-5.5", "send:hello:steer"], "recorded on the conversation before the message");

  const own = fake({ session: { model } });
  await send(own.agent, "s", "hello", () => false, async () => true, "openai/gpt-5.5");
  assert.deepEqual(own.calls, ["send:hello:steer"], "a conversation's own model is never replaced by the default");

  const gone = fake();
  const refused = await send(gone.agent, "s", "hello", () => false, async () => false, "local/gone");
  assert.equal(!refused.ok && refused.error.code, "model_unavailable");
  assert.deepEqual(gone.calls, [], "nothing was recorded");
});

test("a Stop before a send reaches the agent keeps it from being recorded; one after it cancels what was recorded", async () => {
  const { agent, calls } = fake();
  const held = sends();
  const cancelled: string[] = [];
  const cancel = async () => void cancelled.push("cancel");
  assert.equal((await held.stop("a", "s", cancel)).ok, true, "with nothing on its way, a stop is just the cancel");

  let opened!: () => void;
  const opening = new Promise<void>((resolve) => (opened = resolve));
  const early = held.hold("a", "s", async (stopped) => {
    await opening;
    return send(agent, "s", "hello", stopped, async () => true);
  });
  await held.stop("b", "s", cancel);
  assert.deepEqual(
    await Promise.race([early.then(() => "settled"), new Promise((r) => setImmediate(() => r("waiting")))]),
    "waiting",
    "another conversation's stop is not this one's",
  );
  await held.stop("a", "s", cancel);
  opened();
  const result = await early;
  assert.deepEqual(calls, [], "nothing reached the agent");
  assert.equal(!result.ok && result.error.code, "stopped");

  // The Stop lands while the message is being recorded.
  let recording!: () => void;
  const recorded = fake();
  (recorded.agent.messages as { send: unknown }).send = async () => {
    await new Promise<void>((resolve) => (recording = resolve));
    return { id: "m2", sessionId: "s", status: "queued" };
  };
  const mid = held.hold("a", "s", (stopped) => send(recorded.agent, "s", "again", stopped, async () => true));
  await new Promise((resolve) => setImmediate(resolve));
  await held.stop("a", "s", cancel);
  recording();
  assert.deepEqual(await mid, { ok: true, messageId: "m2" });
  assert.deepEqual(recorded.calls, ["cancel"], "the message that was recorded is cancelled");
});

test("once quitting began, a message is refused before it reaches the agent", async () => {
  const held = sends();
  held.quit();
  let started = false;
  const refused = await held.hold("a", "s", async () => {
    started = true;
    return { ok: true };
  });
  assert.equal(started, false);
  assert.equal(!refused.ok && refused.error.code, "quitting");
});

function sessionsAgent(statuses: Record<string, string>, onCancel: (id: string) => void) {
  return {
    sessions: {
      list: async () => ({ data: Object.entries(statuses).map(([id, status]) => ({ id, status })) }),
      cancel: async (id: string) => {
        onCancel(id);
        return { stopped: [] };
      },
    },
  } as unknown as Agent;
}

test("quitting cancels every running session and waits for each to go idle, but not past its limit", async () => {
  const statuses: Record<string, string> = { a: "running", b: "idle", c: "something-new" };
  const cancelled: string[] = [];
  const agent = sessionsAgent(statuses, (id) => {
    cancelled.push(id);
    setTimeout(() => (statuses[id] = "idle"), 20);
  });
  assert.deepEqual(await runningSessions([{ id: "x", agent }]), [
    { agentId: "x", session: "a" },
    { agentId: "x", session: "c" },
  ], "a status this app does not know is running");
  assert.equal(await stopRuns([{ id: "x", agent }], 1000), true);
  assert.deepEqual(cancelled.sort(), ["a", "c"]);

  const stuck = sessionsAgent({ s: "running", t: "running" }, () => {});
  const failing = sessionsAgent({ u: "running" }, () => {
    throw new Error("the agent was removed");
  });
  const began = Date.now();
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await stopRuns([{ id: "stuck", agent: stuck }, { id: "failing", agent: failing }], 100), false);
  } finally {
    console.error = originalError;
  }
  assert.ok(Date.now() - began < 1500);
});
