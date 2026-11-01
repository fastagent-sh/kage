import type { Entry, Message, Session, SessionEvent } from "@fastagent-sh/fastagent";
import type { Ending } from "../main/follow.ts";
import type { DuangApi, Models, LoginStep, OpenResult, Result, SessionFrame } from "../preload/index.ts";
import { createStore } from "./store.ts";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const described = (specs: string[]): Models => specs.map((spec) => ({ spec, thinkingLevels: ["off"] as const }));

// `satisfies`, not a type annotation: an imported binding is not narrowed to the literal, and the tests spread this one.
export const ready = { ok: true, model: "provider/model", sessions: [], windows: {} } satisfies OpenResult;

export const listed = (session: string): OpenResult => ({
  ...ready,
  sessions: [{ session, updatedAt: 5, preview: "an earlier message" }],
});

// FastAgent's objects, as little of them as a test needs.
export const sessionOf = (id: string, extra: Partial<Session> = {}) =>
  ({ id, status: "idle", usage: { models: {}, tools: {} }, ...extra }) as Session;
export const runningSession = (id = "s", extra: Partial<Session> = {}) => sessionOf(id, { status: "running", ...extra });
export const opened = (entries: Entry[] = [], session: Session = sessionOf("s"), lastMessage?: Message) => ({
  session,
  entries,
  ...(lastMessage && { lastMessage }),
});
export const empty = () => opened();

export const userEntry = (id: string, text: string, messageId?: string): Entry =>
  ({ id, timestamp: Number(id.replace(/\D/g, "")) || 1, kind: "user", data: { content: [{ type: "text", text }], ...(messageId && { messageId }) } }) as Entry;
export const assistantEntry = (id: string, data: object = {}): Entry =>
  ({ id, timestamp: Number(id.replace(/\D/g, "")) || 1, kind: "assistant", data: { text: "", usage: {}, ...data } }) as Entry;
export const resultEntry = (id: string, toolCallId: string, text = "ok"): Entry =>
  ({ id, timestamp: Number(id.replace(/\D/g, "")) || 1, kind: "tool_result", data: { toolCallId, toolName: "bash", isError: false, content: [{ type: "text", text }] } }) as Entry;
export const messageOf = (id: string, status: Message["status"], extra: Partial<Message> = {}) =>
  ({ id, sessionId: "s", status, ...extra }) as Message;

export const events = {
  entry: (entry: Entry): SessionEvent => ({ type: "entry", entry }),
  state: (session: Session): SessionEvent => ({ type: "state", session }),
  delta: (text: string, channel: "text" | "thinking" = "text"): SessionEvent => ({ type: "delta", channel, text }),
  toolStarted: (toolCallId: string, name = "bash", args: Record<string, string> = {}): SessionEvent => ({ type: "tool_started", toolCallId, name, args }),
  toolProgress: (toolCallId: string, text: string): SessionEvent => ({ type: "tool_progress", toolCallId, text }),
  retrying: (attempt: number, reason: string): SessionEvent => ({ type: "retrying", attempt, maxAttempts: 3, delayMs: 1000, reason }),
  done: (message: Message): SessionEvent => ({ type: "done", message }),
};
export function harness() {
  let listener!: (frame: SessionFrame) => void;
  let stepListener!: (step: LoginStep) => void;
  const closed: string[] = [];
  const opens: string[] = [];
  const api: DuangApi = {
    homeDir: undefined,
    listAgents: async () => [
      { id: "a", name: "A", dir: "/a", colour: 0 },
      { id: "b", name: "B", dir: "/b", colour: 1 },
    ],
    pickFolder: async () => undefined,
    createAgent: async (name) => ({ ok: true, agent: { id: "c", name, dir: `/Agents/${name}`, colour: 2 } }),
    openAgent: async () => ready,
    addAgentFolder: async (_id, folder) => ({
      ok: true,
      content: [{ name: folder.split("/").pop() ?? "folder", location: folder }],
    }),
    removeAgentFolder: async () => ({ ok: true, content: [] }),
    setAgentSecret: async (_id, name) => ({
      ok: true,
      inspection: {
        files: [],
        packages: [],
        secrets: [{ name, optional: true, declaredIn: [".secrets/.env"], configured: true, fromFile: true }],
      },
    }),
    removeAgentSecret: async () => ({
      ok: true,
      inspection: { files: [], packages: [], secrets: [] },
    }),
    setModel: async () => ({ ok: true }) as Result,
    setThinking: async () => ({ ok: true }) as Result,
    readState: async (_id, session) => sessionOf(session),
    removeAgent: async () => ({ ok: true }) as Result,
    resetAgentConfig: async () => ({ ok: true }),
    listCommands: async () => [],
    revealAgent: async () => {},
    revealRegistry: async () => {},
    openExternal: async () => {},
    listModels: async () => (described(["provider/model"])),
    providerUsage: async (provider) => ({ provider, fetchedAt: 0 }),
    openUsagePage: async () => {},
    getSettings: async () => ({ network: { mode: "automatic" }, avatar: "gaze" }),
    getRoute: async () => ({ source: "system" }),
    setNetwork: async () => ({ source: "system" }),
    setAvatar: async () => {},
    revealSettings: async () => {},
    testNetwork: async () => ({ status: 200, ms: 1, route: { source: "system" } }),
    onOpenSettings: () => () => {},
    setUnseenCount: async () => {},
    menu: async () => undefined,
    renameAgent: async () => {},
    createSession: async () => crypto.randomUUID(),
    openSession: async (_id, session) => {
      opens.push(session);
      return opened([], sessionOf(session));
    },
    readSession: async () => [],
    closeSession: async (subscription) => {
      closed.push(subscription);
    },
    send: async () => ({ ok: true, messageId: crypto.randomUUID() }),
    abort: async () => ({ ok: true }),
    onSessionEvent: (fn) => {
      listener = fn;
      // Unregistering is real here, so a store that stops listening is seen to stop hearing.
      return () => {
        if (listener === fn) listener = () => {};
      };
    },
    listProviders: async () => [],
    revealProviders: async () => {},
    disconnect: async () => {},
    login: async () => ({ ok: true, verified: "n/a" }),
    answerLogin: async () => {},
    cancelLogin: async () => {},
    openLoginUrl: async () => {},
    onLoginStep: (fn) => {
      stepListener = fn;
      return () => {
        if (stepListener === fn) stepListener = () => {};
      };
    },
  };
  const store = createStore(api);
  const emit = (c: NonNullable<ReturnType<typeof store.getSnapshot>["conversation"]>, event: SessionEvent) => {
    listener({ agentId: c.agentId, session: c.session, subscription: c.subscription, event });
  };
  const end = (
    c: NonNullable<ReturnType<typeof store.getSnapshot>["conversation"]>,
    reason: string,
    why: Ending,
  ) => {
    listener({ agentId: c.agentId, session: c.session, subscription: c.subscription, ended: { reason, why } });
  };
  const step = (s: LoginStep) => stepListener(s);
  return { api, store, emit, end, step, closed, opens };
}

export function panes(store: ReturnType<typeof harness>["store"]) {
  const seen: string[] = [];
  const stop = store.subscribe(() => {
    const pane = store.getSnapshot().pane;
    if (seen.at(-1) !== pane) seen.push(pane);
  });
  return { seen, stop };
}
