// Changed in place: the store tells a closed or reopened conversation from the current one by identity.
import type { Entry, Message, Session, SessionEvent } from "@fastagent-sh/fastagent";
import { specOf } from "../shared/model-spec.ts";
import {
  emptyFold,
  failureOf,
  foldEntries,
  foldEntry,
  foldLine,
  foldNote,
  itemsOf,
  liveStep,
  noLive,
  stoppedNote,
  type Fold,
  type Live,
} from "./fold.ts";
import { opensRun, type Item, type UserItem } from "./transcript.ts";

export interface Trouble {
  title: string;
  advice?: string;
  reason: string;
}

export interface SessionState {
  status: "idle" | "running";
  model?: string;
  thinkingLevel?: string;
}

/** A status this app does not know counts as running (FastAgent's rule for an open set). */
export const stateOf = (session: Session): SessionState => ({
  status: session.status === "idle" ? "idle" : "running",
  ...(session.model && { model: specOf(session.model) }),
  ...(session.thinkingLevel && { thinkingLevel: session.thinkingLevel }),
});

export interface Conversation {
  agentId: string;
  session: string;
  subscription: string;
  fold: Fold;
  live: Live;
  items: Item[];
  state?: SessionState;
  draft: string;
  loading: boolean;
  error?: Trouble;
  ended?: string;
  sends: number;
  events: SessionEvent[];
  // Shown below the live output until FastAgent takes them in: a steer is read at the next step.
  waiting: UserItem[];
  // Messages that ended before the answer to their send arrived.
  finished: Map<string, Message>;
  started?: number;
  heard?: number;
}

export type Settled = "completed" | "failed" | "aborted";

const FINISHED_KEPT = 50;

export function createConversation(agentId: string, session: string, draft: string): Conversation {
  return {
    agentId,
    session,
    subscription: crypto.randomUUID(),
    fold: emptyFold(),
    live: noLive(),
    items: [],
    draft,
    loading: true,
    sends: 0,
    events: [],
    waiting: [],
    finished: new Map(),
  };
}

export const busy = (c: Conversation) => c.sends > 0 || c.state?.status === "running" || c.waiting.some((item) => item.messageId !== undefined);

/** How full the context is now, in tokens; unknown after a compaction until the next answer. */
export const contextUsed = (c: Conversation) => c.fold.context;

const refresh = (c: Conversation) => {
  c.items = itemsOf(c.fold, c.state?.status === "running", c.live);
};

/** A line only this window says (a refusal, a failed request), placed with what the record holds so it stays put. */
export function addLine(c: Conversation, item: Item): void {
  c.fold = foldLine(c.fold, item);
  refresh(c);
}

export interface Opened {
  session: Session;
  entries: Entry[];
  // The message of the newest user entry, which says how a turn that left no answer ended.
  lastMessage?: Message;
}

// A running local turn keeps its subscription across navigation, so its deltas never come from history.
export function backfill(c: Conversation, opened: Opened, now: number): Settled[] {
  c.fold = foldEntries(opened.entries);
  c.state = stateOf(opened.session);
  c.live = liveStep(noLive(), { type: "state", session: opened.session }, now);
  if (c.state.status === "running") {
    // Opened mid-run: its silence counts from now, and its clock from the message it is answering.
    c.heard = now;
    c.started = c.fold.items.findLast((item) => item.kind === "user")?.at;
  } else if (c.fold.open && opened.lastMessage) {
    const { lastMessage: message } = opened;
    const note =
      message.status === "failed" && message.error
        ? failureOf(c.fold, message.error, now)
        : message.status === "canceled"
          ? stoppedNote(c.fold, now)
          : undefined;
    if (note) c.fold = foldNote(c.fold, note);
  }
  c.loading = false;
  refresh(c);
  const settled = c.events.flatMap((event) => apply(c, event, now) ?? []);
  c.events = [];
  return settled;
}

// What the person did, not run output: these do not end the model's silence.
const personSide = (event: SessionEvent) => event.type === "state" || (event.type === "entry" && event.entry.kind === "user");

export function receive(c: Conversation, event: SessionEvent, now: number): Settled | undefined {
  if (!personSide(event)) c.heard = now;
  if (c.loading) {
    c.events.push(event);
    return undefined;
  }
  return apply(c, event, now);
}

function running(c: Conversation, now: number) {
  if (c.state?.status === "running") return;
  c.state = { ...c.state, status: "running" };
  c.started = now;
}

function apply(c: Conversation, event: SessionEvent, now: number): Settled | undefined {
  c.live = liveStep(c.live, event, now);
  let settled: Settled | undefined;
  if (event.type === "entry") {
    const before = c.fold;
    c.fold = foldEntry(before, event.entry);
    if (c.fold !== before && event.entry.kind === "user") {
      enter(c);
      // FastAgent reports a status only in the snapshot, so a message taken is what starts a run here.
      running(c, now);
    }
  } else if (event.type === "state") {
    const was = c.state?.status;
    c.state = stateOf(event.session);
    if (c.state.status === "running" && was !== "running") c.started = now;
    if (c.state.status !== "running") c.started = undefined;
  } else if (event.type === "done") {
    settled = finish(c, event.message, now);
    // The next message is taken in the same commit: its entry follows at once, so it is not an idle moment.
    if (c.state && !c.waiting.some((item) => item.messageId !== undefined)) {
      c.state = { ...c.state, status: "idle" };
      c.started = undefined;
    }
  }
  refresh(c);
  return settled;
}

// A message the history already holds (backfill overlapping the live stream) is not placed twice. Claimed by
// message id; by text for one whose send has not been answered yet, since the entry can land first.
function enter(c: Conversation) {
  const placed = c.fold.items.at(-1);
  if (placed?.kind !== "user") return;
  const own =
    c.waiting.find((item) => placed.messageId !== undefined && item.messageId === placed.messageId) ??
    c.waiting.find((item) => item.messageId === undefined && item.text === placed.text);
  if (!own) return;
  c.waiting = c.waiting.filter((item) => item !== own);
  const items = [...c.fold.items];
  items[items.length - 1] = { ...placed, steered: !own.opens };
  c.fold = { ...c.fold, items };
}

function finish(c: Conversation, message: Message, now: number): Settled {
  c.finished.set(message.id, message);
  if (c.finished.size > FINISHED_KEPT) c.finished.delete(c.finished.keys().next().value!);
  const entered = c.fold.items.some((item) => item.kind === "user" && item.messageId === message.id);
  const echo = c.waiting.find((item) => item.messageId === message.id);
  if (echo && !entered) {
    // It never entered the conversation, so it is still the person's: it goes back to the composer.
    c.waiting = c.waiting.filter((item) => item !== echo);
    c.draft = c.draft ? `${echo.text}\n${c.draft}` : echo.text;
    if (message.status === "failed" && message.error)
      c.fold = foldNote(c.fold, { kind: "note", tone: "warning", text: message.error.message, reason: message.error.message, title: "Not sent", advice: "Your message is back in the composer.", at: now });
  } else if (entered) {
    const note =
      message.status === "failed" && message.error
        ? failureOf(c.fold, message.error, now)
        : message.status === "canceled"
          ? stoppedNote(c.fold, now)
          : undefined;
    if (note) c.fold = foldNote(c.fold, note);
  }
  return message.status === "failed" ? "failed" : message.status === "canceled" ? "aborted" : "completed";
}

// Where it goes is FastAgent's report: it waits below the output until its user entry places it.
export function sent(c: Conversation, text: string, now: number): UserItem {
  const echo: UserItem = { kind: "user", text, at: now, opens: opensRun(c.state?.status) };
  // A new run's silence counts from its message; a steer is the person, not the model, and leaves it be.
  if (echo.opens) c.heard = now;
  c.waiting = [...c.waiting, echo];
  return echo;
}

export function unsent(c: Conversation, echo: UserItem): void {
  c.waiting = c.waiting.filter((item) => item !== echo);
  c.draft = c.draft ? `${echo.text}\n${c.draft}` : echo.text;
}

/** FastAgent recorded the message. It may already have ended: the answer to a send can arrive after its events. */
export function accepted(c: Conversation, echo: UserItem, messageId: string, now: number): Settled | undefined {
  if (!c.waiting.includes(echo)) return undefined;
  echo.messageId = messageId;
  const ended = c.finished.get(messageId);
  if (!ended) return undefined;
  const settled = finish(c, ended, now);
  refresh(c);
  return settled;
}

export function lost(c: Conversation, ending: { reason: string; why: "let_go" | "ended" | "failed" }): void {
  // Nothing will report the end of a run this view can no longer hear, so stop waiting for one.
  // Retry re-opens and re-reads FastAgent's real state.
  if (c.state) c.state = { ...c.state, status: "idle" };
  c.started = undefined;
  c.live = noLive();
  refresh(c);
  if (ending.why !== "failed") c.ended = ending.reason;
  else
    c.error = {
      title: "The live connection to this conversation was lost",
      advice: "A run in it goes on in duang. Reconnect to see where it is now.",
      reason: ending.reason,
    };
}
