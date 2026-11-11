import { MODEL_UNAVAILABLE_CODE, STOPPED_CODE } from "../shared/refusals.ts";
import type {
  AgentCapability,
  AgentContent,
  AgentInspection,
  AgentRow,
  AgentSetup,
  KageApi,
  SessionFrame,
  SessionSummary,
} from "../preload/index.ts";
import { foldEntries, itemsOf, noLive } from "./fold.ts";
import { phase, previewOf, queueView, type Activity, type Place } from "./transcript.ts";
import {
  accepted,
  addLine,
  backfill,
  busy,
  createConversation,
  lost,
  receive,
  sent,
  stateOf,
  unsent,
  type Conversation,
  type Settled,
  type Trouble,
} from "./conversation.ts";
import { message } from "./message.ts";
import { createDraftStorage } from "./drafts.ts";
import type { Fix } from "./problems.ts";
import { createSettings, type SettingsView } from "./settings-store.ts";
import { createAgentResources, type AgentResourcesView } from "./agent-resources.ts";
import { createProviderUsage, type PlanUsageView } from "./provider-usage.ts";

// A subscription lost again this soon after reconnecting by itself waits for the person.
const RECONNECT_GAP_MS = 30_000;

export type AgentState = "ready" | AgentSetup;
// `settling`: an agent still opening, or history not yet arrived; showing `start` there would flash the wrong screen.
type Pane =
  | "unreadable-registry"
  | "no-agents"
  | "broken"
  | "missing-dir"
  | "settling"
  | "start"
  | "transcript";
// Navigation only: losing it costs one click, so it is best effort and anything unreadable is a first start.
const SELECTION_KEY = "kage.selection";
interface Selection {
  agentId?: string;
  perAgent: [string, string][];
  // A crash-recovery conversation, kept as the selection so a reload does not reopen the one that crashed.
  fresh?: string;
}
function readSelection(): Selection | undefined {
  try {
    const stored = globalThis.localStorage?.getItem(SELECTION_KEY);
    const parsed = stored ? (JSON.parse(stored) as Selection) : undefined;
    return parsed && Array.isArray(parsed.perAgent) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
function writeStored(storageKey: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(storageKey, value);
  } catch (error) {
    console.error(`kage: ${storageKey} was not saved:`, error);
  }
}
// Presentation only: never written anywhere; the transcript stays the runtime's.
export interface Preview {
  session: string;
  text?: string;
  at?: number;
  error?: string;
}
// Why the person is being asked for a model: the conversation's own question (it has nothing to run with), the
// agent's default this computer no longer knows, or the model a send was turned away for. Choosing a model, or
// leaving the conversation, clears it.
export type ModelAsk =
  | { reason: "needs" }
  | { reason: "gone"; model: string }
  | { reason: "refused"; model: string };
// A send the runtime refused for its model, and kage's own default for an agent that pi does not know: stored
// facts, each about one conversation or one agent, turned into the ask above in one place.
type Refusal = { agentId: string; session: string; model: string };
type StaleDefault = { agentId: string; model: string };

export interface View extends SettingsView, AgentResourcesView {
  agents: AgentRow[];
  agentId?: string;
  states: Record<string, AgentState>;
  sessions: Record<string, SessionSummary[]>;
  content: Record<string, AgentContent[]>;
  tools: Record<string, AgentCapability[]>;
  agentCommands: Record<string, AgentCapability[]>;
  inspection: Record<string, AgentInspection>;
  // The window of each model the open agent offers, in tokens: what the context meter is measured against.
  contextWindows: Record<string, number>;
  // An empty list and a failed one are not the same.
  sessionsError: Record<string, string>;
  model?: string;
  loading: boolean;
  changingModel?: string;
  error?: string;
  errorInConfig?: true;
  errorModel?: string;
  failure?: { title: string; reason: string };
  registryError?: string;
  draftsError?: string;
  conversation?: Conversation;
  busy: boolean;
  pane: Pane;
  alert?: Trouble;
  // One rule: the placeholder shows it and `send` treats reaching it as a bug.
  blocked?: string;
  resend?: { text: string; toolsRan: boolean };
  modelAsk?: ModelAsk;
  picker: boolean;
  // No model anywhere for this conversation: what the chip says.
  needsModel: boolean;
  modelBlocked?: string;
  running: Record<string, string[]>;
  doing: Record<string, Activity>;
  unsent: Record<string, string[]>;
  // Spent by opening the conversation, like an unread mark.
  unseen: Record<string, Record<string, "done" | "failed">>;
  usage: PlanUsageView;
  previews: Record<string, Preview>;
}
const key = (agentId: string, session: string) => `${agentId}/${session}`;
const unkey = (id: string): [string, string] => [id.slice(0, id.indexOf("/")), id.slice(id.indexOf("/") + 1)];
const group = (pairs: [string, string][]): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const [agentId, session] of pairs) (out[agentId] ??= []).push(session);
  return out;
};

// The pane, the alert and why the composer cannot send are one decision, made only here.
function paneOf(view: View): Pane {
  const { agentId, conversation: c } = view;
  if (!agentId) return view.registryError ? "unreadable-registry" : "no-agents";
  const state = view.states[agentId];
  if (state === "broken") return "broken";
  if (state === "missing_dir") return "missing-dir";
  // Not known yet: the agent is still opening (at launch, or the first time it is chosen), and may well
  // have conversations to show.
  if (state === undefined) return "settling";
  const sessions = view.sessions[agentId] ?? [];
  // A ready agent with no conversation open is about to open one: its newest, if it has any.
  if (c ? c.loading && sessions.some((s) => s.session === c.session) : sessions.length > 0) return "settling";
  const shown = c && (c.items.length > 0 || queueView(c.waiting).length > 0);
  return shown ? "transcript" : "start";
}
function alertOf(view: View): Trouble | undefined {
  const c = view.conversation;
  if (c?.error) return c.error;
  if (!view.agentId || !view.error) return undefined;
  // A setup problem's own panel offers the fix; the runtime's prose ("run `fastagent init`") would contradict it.
  const state = view.states[view.agentId];
  if (state === "broken" || state === "missing_dir") return undefined;
  return { title: "This agent could not be opened", advice: "Try again; its folder and conversations are untouched.", reason: view.error };
}
function modelBlockedBy(view: View): string | undefined {
  const { agentId, conversation: c } = view;
  if (!agentId) return "Select an agent first";
  // A model change mid-run would leave the transcript's model and the one answering apart for a step.
  if (view.busy) return "Stop the turn to change the model or effort";
  const state = view.states[agentId];
  if (view.loading || view.changingModel === agentId || c?.loading || state === "broken" || state === "missing_dir")
    return "This agent is not ready";
  return undefined;
}
function blockedBy(view: View): string | undefined {
  const c = view.conversation;
  const state = view.agentId ? view.states[view.agentId] : undefined;
  if (view.loading || c?.loading) return "opening conversation…";
  if (view.agentId && view.changingModel === view.agentId) return "changing the model…";
  if (c?.error || c?.ended) return "reconnect before sending";
  if (state === "broken") return "this agent is broken";
  if (state === "missing_dir") return "this agent's folder is missing";
  if (!c) return "no conversation";
  if (state !== "ready") return "this agent is not ready";
  // A conversation that records no model, of an agent with no default: it runs once one is chosen.
  if (!(c.state?.model ?? view.model)) return "pick a model to start";
  return undefined;
}

// The one place that decides what the picker has to say: a send refused for this conversation's model first (the
// most recent answer to why it cannot run), then the agent's default this computer no longer knows, then a
// conversation with no model at all.
function modelAskOf(view: View, refusal: Refusal | undefined, staleDefault: StaleDefault | undefined): ModelAsk | undefined {
  const { agentId, conversation: c } = view;
  if (!agentId || !c || c.loading) return undefined;
  if (refusal && refusal.agentId === agentId && refusal.session === c.session) return { reason: "refused", model: refusal.model };
  if (staleDefault?.agentId === agentId) return { reason: "gone", model: staleDefault.model };
  // As opposed to kage not knowing the model yet, which does not ask for one.
  if (view.states[agentId] === "ready" && !(c.state?.model ?? view.model)) return { reason: "needs" };
  return undefined;
}

// Runtime data stays in the runtime; this store owns selection, drafts and live, not-yet-durable output.
function derive(
  view: View,
  held: Conversation[],
  unsent: Map<string, string>,
  unseen: Map<string, "done" | "failed">,
  refusal: Refusal | undefined,
  staleDefault: StaleDefault | undefined,
): View {
  const running = held.filter(busy);
  const open = view.conversation;
  const derived: View = {
    ...view,
    busy: !!open && busy(open),
    running: group(running.map((c) => [c.agentId, c.session])),
    doing: Object.fromEntries(running.map((c) => [c.agentId, phase(c.items, c.state?.status).activity])),
    unsent: group([...unsent].filter(([, text]) => text.trim()).map(([id]) => unkey(id))),
    unseen: {},
    needsModel: !!open && !open.loading && view.states[open.agentId] === "ready" && !(open.state?.model ?? view.model),
  };
  for (const [id, outcome] of unseen) {
    const [agentId, session] = unkey(id);
    (derived.unseen[agentId] ??= {})[session] = outcome;
  }
  derived.modelAsk = modelAskOf(derived, refusal, staleDefault);
  derived.pane = paneOf(derived);
  derived.alert = alertOf(derived);
  derived.blocked = blockedBy(derived);
  derived.modelBlocked = modelBlockedBy(derived);
  // Anything after the failure (a newer turn, a stop) leaves nothing to send again.
  const last = open?.items.at(-1);
  derived.resend = !derived.busy && !derived.blocked && last?.kind === "note" ? last.resend : undefined;
  return derived;
}

export function createStore(api: KageApi) {
  let view: View = {
    agents: [],
    states: {},
    sessions: {},
    content: {},
    tools: {},
    agentCommands: {},
    inspection: {},
    contextWindows: {},
    sessionsError: {},
    loading: false,
    busy: false,
    pane: "no-agents",
    picker: false,
    needsModel: false,
    commands: [],
    avatar: "gaze",
    running: {},
    doing: {},
    unsent: {},
    unseen: {},
    usage: {},
    previews: {},
  };
  const listeners = new Set<() => void>();
  const conversations = new Map<string, Conversation>();
  const draftStorage = createDraftStorage();
  const drafts = new Map<string, string>(draftStorage.entries);
  // Where each conversation was left scrolled above the latest line: leaving it unmounts its view.
  const scrolls = new Map<string, Place>();
  let asked: string | undefined;
  let refusal: Refusal | undefined;
  let staleDefault: StaleDefault | undefined;
  const stored = readSelection();
  const lastOpened = new Map<string, string>(stored?.perAgent);
  // In memory on purpose: it is about this window's attention; the transcript is the only durable record.
  const unseen = new Map<string, "done" | "failed">();
  let lastAgent = stored?.agentId;
  let freshSession = stored?.fresh;
  let navigation = 0;
  // One request number per agent: a slow answer never overwrites a newer one.
  const tickets = () => {
    const latest = new Map<string, number>();
    return (id: string) => {
      const request = (latest.get(id) ?? 0) + 1;
      latest.set(id, request);
      return () => latest.get(id) === request;
    };
  };
  const listTicket = tickets();
  const previewTicket = tickets();
  const previews = new Map<string, Preview & { updatedAt?: number }>();
  // Which conversation an agent opens: the one it was left on while anything still knows it (the runtime, a held
  // conversation, unsent text, or the fresh start a crash left selected), else one running now, else the newest
  // the runtime lists. One rule, so the row quotes what a click opens.
  const openable = (id: string, sessions: SessionSummary[]): string | undefined => {
    const held = [...conversations.values()].filter((c) => c.agentId === id);
    const known = (session: string) =>
      sessions.some((s) => s.session === session) || held.some((c) => c.session === session);
    const left = lastOpened.get(id);
    if (left && (known(left) || drafts.get(key(id, left))?.trim() || left === freshSession)) return left;
    // The runtime lists the most recently active first.
    return held.find(busy)?.session ?? sessions[0]?.session;
  };
  const selectedSession = (id: string): string | undefined =>
    view.conversation?.agentId === id ? view.conversation.session : openable(id, view.sessions[id] ?? []);
  const publish = (patch: Partial<View> = {}) => {
    view = { ...view, ...patch };
    // Read before the loop below releases anything: a settled run's last event is what the row keeps.
    // A sent message is the newest thing from the moment it is sent, not once the runtime reports it.
    for (const c of conversations.values())
      if (!c.loading && selectedSession(c.agentId) === c.session) {
        const opening = c.waiting.findLast((item) => item.opens);
        previews.set(c.agentId, { session: c.session, ...previewOf(opening ? [...c.items, opening] : c.items) });
      }
    for (const [id, preview] of previews) if (selectedSession(id) !== preview.session) previews.delete(id);
    view.previews = Object.fromEntries([...previews].map(([id, { updatedAt: _read, ...preview }]) => [id, preview]));
    // Retention is decided here, where every way a turn ends passes. A conversation nobody looks at is kept
    // only while it can still produce something: its own backfill, or a turn in flight.
    for (const c of conversations.values()) if (!busy(c) && c !== view.conversation && !c.loading) close(c);
    // A conversation the runtime never heard of exists only on screen, so leaving its unsent text would discard it.
    const unsent = new Map(drafts);
    if (view.conversation) unsent.set(key(view.conversation.agentId, view.conversation.session), view.conversation.draft);
    view.draftsError = draftStorage.save([...unsent].filter(([, text]) => text.trim()));
    view = derive(view, [...conversations.values()], unsent, unseen, refusal, staleDefault);
    // A picker the person closed stays closed: it opens when the ask becomes a different one, and closes when
    // there is nothing to ask. A refusal opened it where it happened, so a return does not open it again.
    if (!view.conversation?.loading) {
      const question = view.modelAsk
        ? `${view.conversation?.agentId}/${view.conversation?.session}/${view.modelAsk.reason}/${view.modelAsk.reason === "needs" ? "" : view.modelAsk.model}`
        : "";
      if (question !== asked) {
        asked = question;
        if (view.modelAsk?.reason !== "refused") view.picker = !!view.modelAsk;
      }
    }
    for (const listener of listeners) listener();
  };
  // `warning` is a refusal: it never ran, so the text is still the person's; a failure already had effects.
  const note = (
    c: Conversation | undefined,
    problem: { error: unknown; title: string; tone?: "warning" | "error"; advice?: string; fix?: Fix },
  ) => {
    const reason = message(problem.error);
    if (!c) return fail(problem.title, problem.error);
    const { error: _error, tone = "error", ...said } = problem;
    addLine(c, { kind: "note", tone, text: reason, reason, ...said, at: Date.now() });
    publish();
  };
  const fail = (title: string, error: unknown) => publish({ failure: { title, reason: message(error) } });
  const close = (c: Conversation) => {
    drafts.set(key(c.agentId, c.session), c.draft);
    if (conversations.get(key(c.agentId, c.session)) === c) conversations.delete(key(c.agentId, c.session));
    void api.closeSession(c.subscription).catch((error) => fail("A conversation was not released", error));
  };
  const leave = () => publish({ conversation: undefined });
  // A provider disconnected here leaves a plan's numbers behind, which this store owns: it drops them, so the
  // settings sub-store never reaches into state it does not own.
  const { select: selectResources, closeModels, ...resources } = createAgentResources(api, publish);
  const { forget: forgetUsage, ...usage } = createProviderUsage(api, publish);
  const { onStep, ...settings } = createSettings(api, () => view, publish, forgetUsage);

  // A failure lands on that agent's row: an empty list and an unreadable one are not the same answer.
  async function listSessions(id: string) {
    const current = listTicket(id);
    const settle = (patch: Partial<View>) => {
      if (current()) publish(patch);
    };
    // Never the open agent's `states`: they drive the main panel, which `selectAgent` owns.
    const own = (value: AgentState, model?: string) =>
      id === view.agentId ? (model ? { model } : {}) : { states: { ...view.states, [id]: value } };
    try {
      const result = await api.openAgent(id);
      if (!result.ok)
        return settle({
          sessionsError: { ...view.sessionsError, [id]: result.message },
          ...own(result.code),
        });
      const { [id]: _cleared, ...errors } = view.sessionsError;
      settle({
        sessions: { ...view.sessions, [id]: result.sessions },
        ...(result.content && { content: { ...view.content, [id]: result.content } }),
        sessionsError: errors,
        ...own("ready", result.model),
      });
      if (current()) await readPreview(id);
    } catch (error) {
      settle({ sessionsError: { ...view.sessionsError, [id]: message(error) } });
    }
  }

  async function readPreview(id: string) {
    const session = selectedSession(id);
    if (!session || conversations.has(key(id, session))) return;
    const updatedAt = view.sessions[id]?.find((s) => s.session === session)?.updatedAt;
    const known = previews.get(id);
    if (known?.session === session && known.updatedAt === updatedAt && !known.error) return;
    const current = previewTicket(id);
    let preview: Preview;
    try {
      // The state too: a run still going (after a reload, say) has not been cut short. A compaction is not a
      // run (FastAgent admits one only at a boundary), so a turn cut before it is still cut.
      const [entries, state] = await Promise.all([api.readSession(id, session), api.readState(id, session)]);
      preview = { session, ...previewOf(itemsOf(foldEntries(entries), stateOf(state).status === "running", noLive())) };
    } catch (error) {
      preview = { session, error: message(error) };
    }
    // Only the newest read lands. A conversation opened meanwhile, or a row that moved on to another,
    // needs nothing here: `publish` quotes the live one first and drops a quote that is not selected.
    if (!current()) return;
    previews.set(id, { ...preview, updatedAt });
    publish();
  }

  async function open(session: string) {
    const agentId = view.agentId;
    if (!agentId) return;
    // Already on screen: clearing the view to show the same conversation again would rebuild it, and lose
    // the place being read. (A conversation that was closed, as a retry does, is not on screen.)
    const open = view.conversation;
    if (open?.agentId === agentId && open.session === session && conversations.get(key(agentId, session)) === open) return;
    // A conversation that was refused for its model is not this one's: the ask belongs to what is being opened.
    refusal = undefined;
    unseen.delete(key(agentId, session));
    lastOpened.set(agentId, session);
    lastAgent = agentId;
    if (freshSession && ![...lastOpened.values()].includes(freshSession)) freshSession = undefined;
    writeStored(
      SELECTION_KEY,
      JSON.stringify({ agentId, perAgent: [...lastOpened], ...(freshSession && { fresh: freshSession }) } satisfies Selection),
    );
    // No `leave()` first: clearing the view to put another conversation in it renders the screen for "no
    // conversation" in between. Publishing the next one is what makes the previous one stop being current.
    const existing = conversations.get(key(agentId, session));
    if (existing) {
      publish({ conversation: existing, error: undefined });
      return;
    }
    const c = createConversation(agentId, session, drafts.get(key(agentId, session)) ?? "");
    conversations.set(key(agentId, session), c);
    publish({ conversation: c, error: undefined });
    try {
      const result = await api.openSession(agentId, session, c.subscription);
      if (conversations.get(key(agentId, session)) !== c) return;
      for (const outcome of backfill(c, result, Date.now())) settled(c, outcome);
      publish();
    } catch (error) {
      if (conversations.get(key(agentId, session)) !== c) return;
      c.loading = false;
      c.error = {
        title: "This conversation could not be opened",
        advice: "Its history is untouched. Try again, or choose another conversation.",
        reason: message(error),
      };
      publish();
    }
  }

  async function submit(c: Conversation, text: string) {
    // Notes from before this send are not this send's: a refusal said for an earlier message is said again.
    const before = c.fold.items.length;
    const echo = sent(c, text, Date.now());
    // Once it entered, what happens to it is the run's.
    const waiting = () => c.waiting.includes(echo);
    c.sends++;
    publish();
    try {
      const result = await api.send(c.agentId, c.session, text);
      if (result.ok) {
        // Once it entered, what happens to it is the run's.
        if (waiting()) {
          const outcome = accepted(c, echo, result.messageId, Date.now());
          if (outcome) settled(c, outcome);
        }
        if (result.stopError) note(c, { error: result.stopError.message, title: "The run could not be stopped" });
      } else {
        // Once it entered, the failure is the run's, and the run's note already says it.
        if (!waiting()) return;
        const model = c.state?.model ?? view.model;
        if (result.error.code === MODEL_UNAVAILABLE_CODE && model) {
          // Nothing happened in the conversation, so nothing goes in the transcript; the picker says why.
          unsent(c, echo);
          refusal = { agentId: c.agentId, session: c.session, model };
          publish({ picker: true });
          return;
        }
        if (
          result.error.code !== STOPPED_CODE &&
          !c.fold.items.slice(before).some((item) => item.kind === "note" && item.text.includes(result.error.message))
        )
          note(c, { error: result.error.message, tone: "warning", title: "Not sent", advice: "Your message is back in the composer." });
        unsent(c, echo);
      }
    } catch (error) {
      note(c, { error, title: "The message could not be sent" });
      if (waiting()) unsent(c, echo);
    } finally {
      c.sends--;
      publish();
    }
  }

  async function begin(id: string, known: SessionSummary[]): Promise<string> {
    for (const candidate of known) {
      if (candidate.updatedAt !== undefined) continue;
      const idKey = key(id, candidate.session);
      if (!conversations.has(idKey)) {
        // Released state cannot vouch for a cached blank row.
        const [entries, state] = await Promise.all([
          api.readSession(id, candidate.session),
          api.readState(id, candidate.session),
        ]);
        if (entries.length > 0 || stateOf(state).status !== "idle") continue;
      }
      const held = conversations.get(idKey);
      if (!held || (!held.loading && !busy(held) && held.items.length === 0)) return candidate.session;
    }
    return api.createSession(id);
  }

  async function selectAgent(id: string, session?: string) {
    const request = ++navigation;
    const listCurrent = listTicket(id);
    const left = view.agentId;
    leave();
    if (left && left !== id) void readPreview(left);
    selectResources(id);
    publish({
      agentId: id,
      model: undefined,
      error: undefined,
      errorInConfig: undefined,
      errorModel: undefined,
      loading: true,
    });
    try {
      const result = await api.openAgent(id);
      if (request !== navigation) return;
      if (!result.ok) {
        const { [id]: _staleTools, ...restTools } = view.tools;
        const { [id]: _staleCommands, ...restCommands } = view.agentCommands;
        publish({
          loading: false,
          model: undefined,
          tools: restTools,
          agentCommands: restCommands,
          states: { ...view.states, [id]: result.code },
          error: result.message,
          errorInConfig: result.inConfig,
          errorModel: result.unknownModel,
          ...(result.content && { content: { ...view.content, [id]: result.content } }),
          ...(result.inspection && { inspection: { ...view.inspection, [id]: result.inspection } }),
        });
        return;
      }
      const { [id]: _cleared, ...sessionsError } = view.sessionsError;
      staleDefault = result.staleDefault ? { agentId: id, model: result.staleDefault } : undefined;
      publish({
        loading: false,
        model: result.model,
        contextWindows: result.windows,
        ...(result.content && { content: { ...view.content, [id]: result.content } }),
        ...(result.tools && { tools: { ...view.tools, [id]: result.tools } }),
        ...(result.commands && { agentCommands: { ...view.agentCommands, [id]: result.commands } }),
        ...(result.inspection && { inspection: { ...view.inspection, [id]: result.inspection } }),
        ...(listCurrent() ? { sessions: { ...view.sessions, [id]: result.sessions }, sessionsError } : {}),
        states: { ...view.states, [id]: "ready" },
      });
      // Opened here, inside the navigation guard: a `.then(open)` outside would land on whichever agent the
      // selection had moved to by then.
      await open(session ?? openable(id, result.sessions) ?? (await begin(id, result.sessions)));
      if (request !== navigation) return;
      // After the conversation opened: opening one is what sets the ask, by what it can run.
      if (request === navigation) publish();
    } catch (error) {
      if (request === navigation) {
        const { [id]: _staleTools, ...restTools } = view.tools;
        const { [id]: _staleCommands, ...restCommands } = view.agentCommands;
        publish({
          loading: false,
          model: undefined,
          tools: restTools,
          agentCommands: restCommands,
          error: message(error),
          states: { ...view.states, [id]: "broken" },
        });
      }
    }
  }

  async function refreshOpenAgent(
    id: string,
    fallback: { content?: AgentContent[]; inspection?: AgentInspection } = {},
  ) {
    const prevDescription = view.inspection[id]?.description;
    const withDesc = (insp?: AgentInspection) =>
      insp && prevDescription && !insp.description ? { ...insp, description: prevDescription } : insp;
    if (view.agentId !== id) {
      publish({
        ...(fallback.content && { content: { ...view.content, [id]: fallback.content } }),
        ...(fallback.inspection && { inspection: { ...view.inspection, [id]: withDesc(fallback.inspection)! } }),
      });
      void listSessions(id);
      return;
    }
    const request = ++navigation;
    const listCurrent = listTicket(id);
    selectResources(id);
    publish({ loading: true });
    try {
      const result = await api.openAgent(id);
      const nextContent = result.content ?? fallback.content;
      if (request !== navigation || view.agentId !== id) {
        const nextInspection = result.ok
          ? (result.inspection ?? withDesc(fallback.inspection))
          : withDesc(result.inspection ?? fallback.inspection);
        const { [id]: _cleared, ...sessionsError } = view.sessionsError;
        publish({
          ...(nextContent && { content: { ...view.content, [id]: nextContent } }),
          ...(nextInspection && { inspection: { ...view.inspection, [id]: nextInspection } }),
          ...(listCurrent()
            ? result.ok
              ? {
                  sessions: { ...view.sessions, [id]: result.sessions },
                  sessionsError,
                  ...(view.agentId !== id && { states: { ...view.states, [id]: "ready" } }),
                }
              : {
                  sessionsError: { ...view.sessionsError, [id]: result.message },
                  ...(view.agentId !== id && { states: { ...view.states, [id]: result.code } }),
                }
            : {}),
        });
        if (result.ok && listCurrent()) void readPreview(id);
        return;
      }
      if (!result.ok) {
        if (view.conversation?.agentId === id) close(view.conversation);
        leave();
        const nextInspection = withDesc(result.inspection ?? fallback.inspection);
        const { [id]: _staleTools, ...restTools } = view.tools;
        const { [id]: _staleCommands, ...restCommands } = view.agentCommands;
        publish({
          loading: false,
          model: undefined,
          tools: restTools,
          agentCommands: restCommands,
          states: { ...view.states, [id]: result.code },
          error: result.message,
          errorInConfig: result.inConfig,
          errorModel: result.unknownModel,
          ...(nextContent && { content: { ...view.content, [id]: nextContent } }),
          ...(nextInspection && { inspection: { ...view.inspection, [id]: nextInspection } }),
        });
        return;
      }
      const nextInspection = result.inspection ?? withDesc(fallback.inspection);
      const { [id]: _cleared, ...sessionsError } = view.sessionsError;
      const currentSession = view.conversation?.agentId === id ? view.conversation.session : undefined;
      if (view.conversation?.agentId === id) close(view.conversation);
      staleDefault = result.staleDefault ? { agentId: id, model: result.staleDefault } : undefined;
      publish({
        loading: false,
        error: undefined,
        errorInConfig: undefined,
        errorModel: undefined,
        model: result.model,
        contextWindows: result.windows,
        ...(result.tools && { tools: { ...view.tools, [id]: result.tools } }),
        ...(result.commands && { agentCommands: { ...view.agentCommands, [id]: result.commands } }),
        ...(listCurrent() ? { sessions: { ...view.sessions, [id]: result.sessions }, sessionsError } : {}),
        states: { ...view.states, [id]: "ready" },
      });
      const nextSession = currentSession ?? openable(id, result.sessions) ?? (await begin(id, result.sessions));
      if (request !== navigation || view.agentId !== id) {
        publish({
          ...(nextContent && { content: { ...view.content, [id]: nextContent } }),
          ...(nextInspection && { inspection: { ...view.inspection, [id]: nextInspection } }),
        });
        return;
      }
      await open(nextSession);
      publish({
        ...(nextContent && { content: { ...view.content, [id]: nextContent } }),
        ...(nextInspection && { inspection: { ...view.inspection, [id]: nextInspection } }),
      });
    } catch (error) {
      if (request === navigation && view.agentId === id) {
        if (view.conversation?.agentId === id) close(view.conversation);
        leave();
        const { [id]: _staleTools, ...restTools } = view.tools;
        const { [id]: _staleCommands, ...restCommands } = view.agentCommands;
        publish({
          loading: false,
          model: undefined,
          tools: restTools,
          agentCommands: restCommands,
          error: message(error),
          states: { ...view.states, [id]: "broken" },
        });
      }
    }
  }

  // Read again after a model change, which the session's own events may not have reported before it was subscribed.
  async function readSettings(c: Conversation) {
    try {
      const { model, thinkingLevel } = stateOf(await api.readState(c.agentId, c.session));
      // The read outlived the conversation (closed, or replaced by a reopen): it says nothing about this one.
      if (conversations.get(key(c.agentId, c.session)) !== c || !c.state) return;
      // A model the read does not name is not a change to it; an effort it does not name is one that was cleared.
      const { thinkingLevel: _stale, ...rest } = c.state;
      c.state = { ...rest, ...(model && { model }), ...(thinkingLevel && { thinkingLevel }) };
      publish();
    } catch (error) {
      note(c, { error, title: "This conversation's settings could not be read" });
    }
  }
  // A conversation made since the list was read is listed once it is chosen.
  async function keepListed(c: Conversation) {
    if (!view.sessions[c.agentId]?.some((s) => s.session === c.session)) await listSessions(c.agentId);
  }
  // A run you stopped yourself is not news.
  function settled(c: Conversation, outcome: Settled) {
    if (c !== view.conversation && outcome !== "aborted")
      unseen.set(key(c.agentId, c.session), outcome === "completed" ? "done" : "failed");
    void listSessions(c.agentId);
  }
  const onFrame = (frame: SessionFrame) => {
    const c = conversations.get(key(frame.agentId, frame.session));
    if (!c || c.subscription !== frame.subscription) return;
    if (frame.ended) {
      lost(c, frame.ended);
      publish();
      // FastAgent's contract for a subscriber it let go: listen again and read the history. Once by itself; again
      // soon after waits for the person. Not while a send answers: a refusal refills this composer, which reopening replaces.
      const id = key(c.agentId, c.session);
      if (
        frame.ended.why === "let_go" &&
        view.conversation === c &&
        c.sends === 0 &&
        Date.now() - (reconnected.get(id) ?? -Infinity) > RECONNECT_GAP_MS
      ) {
        reconnected.set(id, Date.now());
        close(c);
        void open(c.session);
      }
      return;
    }
    const outcome = receive(c, frame.event, Date.now());
    if (outcome) settled(c, outcome);
    publish();
  };
  // Registered by `load` and dropped by `dispose`: React (and Fast Refresh) re-runs setup on the same store,
  // and registering anywhere else left a store that never heard a live event.
  let stopFrames: (() => void) | undefined;
  const reconnected = new Map<string, number>();
  let resetting = false;
  let stopSteps: (() => void) | undefined;
  const listen = () => {
    stopFrames ??= api.onSessionEvent(onFrame);
    stopSteps ??= api.onLoginStep(onStep);
  };

  async function load({ fresh = false }: { fresh?: boolean } = {}) {
    listen();
    publish({ loading: true, error: undefined, registryError: undefined });
    // Lands before the roster, so it is never drawn in the default style first. An unreadable settings file
    // keeps the default; main and the Settings page report it.
    const avatar = api.getSettings().then(
      ({ avatar }) => publish({ avatar }),
      () => {},
    );
    try {
      const agents = await api.listAgents();
      await avatar;
      publish({ agents, loading: false });
      const start = agents.find((row) => row.id === lastAgent) ?? agents[0];
      // Reading each list boots each runtime, the same as opening it would.
      for (const row of agents) if (row !== start) void listSessions(row.id);
      if (fresh && start) {
        // A conversation the crash did not touch; if the agent cannot make one, it says why when it is opened.
        freshSession = await api.createSession(start.id).catch(() => undefined);
      }
      if (start) await selectAgent(start.id, fresh ? freshSession : undefined);
    } catch (error) {
      publish({ loading: false, registryError: message(error) });
    }
  }

  return {
    ...settings,
    ...resources,
    ...usage,
    getSnapshot: () => view,
    // Which conversation this agent would open: the row quotes its output, and a click opens it.
    sessionFor: (agentId: string) => selectedSession(agentId),
    scrollOf: (agentId: string, session: string) => scrolls.get(key(agentId, session)),
    rememberScroll(agentId: string, session: string, place: Place | undefined) {
      if (place === undefined) scrolls.delete(key(agentId, session));
      else scrolls.set(key(agentId, session), place);
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    selectAgent,
    // FastAgent owns the session list; kage keeps no second copy. A failure belongs to that agent's row and never
    // touches the open agent's `states`, which would put the window into "this agent is broken".
    listSessions,
    async renameAgent(id: string, name: string) {
      try {
        await api.renameAgent(id, name);
        publish({ agents: await api.listAgents() });
      } catch (error) {
        fail("The agent was not renamed", error);
      }
    },
    open,
    dismissFailure: () => publish({ failure: undefined }),
    openPicker: () => publish({ picker: true }),
    closePicker() {
      closeModels();
      publish({ picker: false });
    },
    async openUsagePage(provider: string) {
      try {
        await api.openUsagePage(provider);
      } catch (error) {
        fail("The usage page did not open", error);
      }
    },
    /** The conversation it opened, when it is still the open one. */
    async newConversation(): Promise<Conversation | undefined> {
      const id = view.agentId;
      if (!id) return undefined;
      const request = navigation;
      try {
        const session = await begin(id, view.sessions[id] ?? []);
        if (request !== navigation) return undefined;
        await open(session);
        void listSessions(id);
        const opened = view.conversation;
        return opened?.agentId === id && opened.session === session ? opened : undefined;
      } catch (error) {
        fail("A new conversation could not be started", error);
        return undefined;
      }
    },
    setDraft: (draft: string) => {
      if (view.conversation) {
        view.conversation.draft = draft;
        publish();
      }
    },
    pickFolder: (): Promise<{ name: string; path: string } | undefined> => api.pickFolder(),
    async createAgent(name: string, folders: string[]): Promise<string | undefined> {
      try {
        const result = await api.createAgent(name, folders);
        if (!result.ok) return result.error.message;
        publish({ agents: await api.listAgents() });
        await selectAgent(result.agent.id);
        return undefined;
      } catch (error) {
        return message(error);
      }
    },
    async addAgentFolder(folder: string, id = view.agentId): Promise<string | undefined> {
      if (!id) return undefined;
      try {
        const result = await api.addAgentFolder(id, folder);
        if (!result.ok) return result.error.message;
        await refreshOpenAgent(id, { content: result.content });
        return undefined;
      } catch (error) {
        return message(error);
      }
    },
    async removeAgentFolder(name: string, id = view.agentId): Promise<string | undefined> {
      if (!id) return undefined;
      try {
        const result = await api.removeAgentFolder(id, name);
        if (!result.ok) return result.error.message;
        await refreshOpenAgent(id, { content: result.content });
        return undefined;
      } catch (error) {
        return message(error);
      }
    },
    async setAgentSecret(name: string, value: string, id = view.agentId): Promise<string | undefined> {
      if (!id) return undefined;
      try {
        const result = await api.setAgentSecret(id, name, value);
        if (!result.ok) return result.error.message;
        await refreshOpenAgent(id, { inspection: result.inspection });
        return undefined;
      } catch (error) {
        return message(error);
      }
    },
    async removeAgentSecret(name: string, id = view.agentId): Promise<string | undefined> {
      if (!id) return undefined;
      try {
        const result = await api.removeAgentSecret(id, name);
        if (!result.ok) return result.error.message;
        await refreshOpenAgent(id, { inspection: result.inspection });
        return undefined;
      } catch (error) {
        return message(error);
      }
    },
    async pickModel(model: string) {
      const id = view.agentId;
      const c = view.conversation;
      if (!id || !c) return;
      const request = navigation;
      // Cleared however the change ends, including after the person went to another agent.
      const settle = () => {
        if (view.changingModel === id) publish({ changingModel: undefined });
      };
      publish({ changingModel: id });
      try {
        const result = await api.setModel(id, model, c.session);
        if (!result.ok) {
          settle();
          // The model did not change, so nothing ran: this is a refusal, not a failure.
          return note(c, { error: result.error.message, tone: "warning", title: "The model was not changed" });
        }
        publish({ agents: await api.listAgents() });
        settle();
        if (request !== navigation) return;
        refusal = undefined;
        staleDefault = undefined;
        publish({ model, error: undefined, states: { ...view.states, [id]: "ready" } });
        // The runtime announced the change before the subscription listened again, so read the settings, not wait.
        await readSettings(c);
        await keepListed(c);
      } catch (error) {
        settle();
        if (request === navigation) note(c, { error, title: "The model was not changed" });
      }
    },
    // Nothing shown ahead of FastAgent: the level shown is the one read back from the conversation.
    async setThinking(level: string) {
      const id = view.agentId;
      const c = view.conversation;
      if (!id || !c) return;
      try {
        const result = await api.setThinking(id, c.session, level);
        if (!result.ok) note(c, { error: result.error.message, tone: "warning", title: "The effort was not changed" });
        else {
          await readSettings(c);
          await keepListed(c);
        }
      } catch (error) {
        note(c, { error, title: "The effort was not changed" });
      }
    },
    async resetConfig() {
      const id = view.agentId;
      // One at a time: the page stays up until the agent has reopened, and a second click is not a second reset.
      if (!id || resetting) return;
      resetting = true;
      try {
        const result = await api.resetAgentConfig(id);
        if (!result.ok) return fail("The config was not replaced", result.error.message);
        await selectAgent(id);
      } catch (error) {
        fail("The config was not replaced", error);
      } finally {
        resetting = false;
      }
    },
    async forgetModel() {
      const id = view.agentId;
      if (!id || resetting) return;
      resetting = true;
      try {
        const result = await api.forgetAgentModel(id);
        if (!result.ok) return fail("The model was not forgotten", result.error.message);
        await selectAgent(id);
      } catch (error) {
        fail("The model was not forgotten", error);
      } finally {
        resetting = false;
      }
    },
    async reveal(agentId = view.agentId, path?: string) {
      try {
        // No agent to name means the list itself is what failed; show that file instead.
        await (agentId ? (path === undefined ? api.revealAgent(agentId) : api.revealAgent(agentId, path)) : api.revealRegistry());
      } catch (error) {
        fail("It could not be shown in Finder", error);
      }
    },
    async openLink(url: string) {
      try {
        await api.openExternal(url);
      } catch (error) {
        fail("The link could not be opened", error);
      }
    },
    async removeAgent() {
      const id = view.agentId;
      if (!id) return;
      try {
        const result = await api.removeAgent(id);
        if (!result.ok) return fail("The agent was not removed", result.error.message);
        for (const c of conversations.values()) if (c.agentId === id) close(c);
        for (const draftKey of [...drafts.keys()]) if (draftKey.startsWith(`${id}/`)) drafts.delete(draftKey);
        for (const scrollKey of [...scrolls.keys()]) if (scrollKey.startsWith(`${id}/`)) scrolls.delete(scrollKey);
        publish({ agents: await api.listAgents() });
        if (view.agentId !== id) return;
        ++navigation;
        const { [id]: _gone, ...rest } = view.sessions;
        const { [id]: _contentGone, ...restContent } = view.content;
        const { [id]: _toolsGone, ...restTools } = view.tools;
        const { [id]: _commandsGone, ...restCommands } = view.agentCommands;
        const { [id]: _inspectionGone, ...restInspection } = view.inspection;
        selectResources();
        publish({
          agentId: undefined,
          conversation: undefined,
          error: undefined,
          sessions: rest,
          content: restContent,
          tools: restTools,
          agentCommands: restCommands,
          inspection: restInspection,
        });
        if (view.agents[0]) await selectAgent(view.agents[0].id);
      } catch (error) {
        fail("The agent was not removed", error);
      }
    },
    async send() {
      const c = view.conversation;
      const text = c?.draft.trim();
      if (!c || !text) return;
      // The composer was disabled and said why, so arriving here is this app's bug rather than a
      // choice the person can revisit. Dropping the message in silence is how that stays hidden.
      if (view.blocked) throw new Error(`Cannot send while ${view.blocked}`);
      c.draft = "";
      await submit(c, text);
    },
    async resend() {
      const c = view.conversation;
      const again = view.resend;
      if (!c || !again) return;
      await submit(c, again.text);
    },
    async abort() {
      const c = view.conversation;
      if (!c) return;
      try {
        const result = await api.abort(c.agentId, c.session);
        if (!result.ok)
          note(c, { error: result.error.message, title: "The run could not be stopped" });
      } catch (error) {
        note(c, { error, title: "The run could not be stopped" });
      }
    },
    async retry() {
      const c = view.conversation;
      if (c) {
        close(c);
        await open(c.session);
      } else if (view.agentId) await selectAgent(view.agentId);
      else await load();
    },
    dispose() {
      stopFrames?.();
      stopSteps?.();
      stopFrames = stopSteps = undefined;
      selectResources();
      for (const c of conversations.values()) close(c);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
