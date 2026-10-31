// A conversation as FastAgent records it (entries, in order) and as it is being written (live events), drawn as the
// items the transcript shows. Entries are the record; the live part is never kept past the entry that replaces it.
import type { Entry, SessionEvent } from "@fastagent-sh/fastagent";
import { textOf } from "../shared/entries.ts";
import { failed, retryReason, type Item } from "./transcript.ts";

type Note = Extract<Item, { kind: "note" }>;

type Tool = Extract<Item, { kind: "tool" }>;

export const TRUNCATED = "answer cut off at the model's output limit";

export interface Fold {
  items: Item[];
  // Shared across versions: entries only ever arrive once each, and history may overlap the live stream.
  ids: Set<string>;
  // Tool calls from here on belong to a run no answer has concluded; a failed run's retry may repeat them.
  unconcluded: number;
  // The newest turn has no answer yet: a user message, or tools whose next step was never written.
  open: boolean;
  // The newest answer failed. If another answer follows in the same turn the agent retried; if not, it stands.
  failure?: { index: number; message: string };
  // The newest answer's tokens, which is how full the context is; a compaction empties it.
  context?: number;
}

export const emptyFold = (): Fold => ({ items: [], ids: new Set(), unconcluded: 0, open: false });

const asData = (entry: Entry) => (entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : {}) as Record<
  string,
  unknown
>;

type Call = { id?: string; name?: string; args?: unknown };

const retriedText = (count: number, reason: string) => `retried ${count === 1 ? "once" : `${count} times`}: ${retryReason(reason)}`;
const isCount = (item: Item | undefined): item is Note & { retry: number } => item?.kind === "note" && !!item.retry;

// The failed answer was retried and the agent went on: retries in a row are one line that counts them.
function retried(fold: Fold): void {
  if (!fold.failure) return;
  const { index, message } = fold.failure;
  fold.failure = undefined;
  const previous = fold.items[index - 1];
  const count = isCount(previous) ? previous.retry + 1 : 1;
  const at = fold.items[index]!.at;
  if (count > 1) fold.items.splice(index - 1, 1);
  fold.items[count > 1 ? index - 1 : index] = { kind: "note", tone: "info", text: retriedText(count, message), reason: message, retry: count, at };
}

// A run that ends on its failure: the line counting the retries before it says what the failure already does.
function concluded(fold: Fold, index: number): number {
  if (!isCount(fold.items[index - 1])) return index;
  fold.items.splice(index - 1, 1);
  return index - 1;
}

function step(fold: Fold, entry: Entry): void {
  const { items } = fold;
  const data = asData(entry);
  const at = entry.timestamp;
  if (entry.kind === "user") {
    // The failure ended its run; what follows is the next one.
    if (fold.failure) fold.unconcluded = concluded(fold, fold.failure.index) + 1;
    fold.failure = undefined;
    fold.open = true;
    items.push({
      kind: "user",
      text: textOf(data.content),
      at,
      entryId: entry.id,
      ...(typeof data.messageId === "string" && { messageId: data.messageId }),
    });
  } else if (entry.kind === "assistant") {
    retried(fold);
    const calls = (data.toolCalls as Call[] | undefined) ?? [];
    const stop = data.stop;
    if (typeof data.thinking === "string" && data.thinking)
      items.push({ kind: "thinking", text: data.thinking, open: false, started: at, at });
    if (typeof data.text === "string" && data.text) items.push({ kind: "assistant", text: data.text, open: false, at });
    for (const call of calls)
      items.push({ kind: "tool", id: call.id ?? "", name: call.name ?? "tool", args: call.args, status: "interrupted", at });
    if (stop === "max_tokens") items.push({ kind: "note", tone: "info", text: TRUNCATED, at });
    else if (stop === "aborted") items.push({ kind: "note", tone: "info", text: "run stopped", at });
    else if (stop === "failed") {
      const message = typeof data.error === "string" ? data.error : "";
      fold.failure = { index: items.length, message };
      items.push(failureNote(fold, message, undefined, at));
    }
    // An answer with no tool call ends its work: a later failure cannot repeat what came before it.
    if (!stop && !calls.length) fold.unconcluded = items.length;
    fold.open = !stop && calls.length > 0;
    const usage = data.usage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined;
    if (usage && !stop)
      fold.context = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  } else if (entry.kind === "tool_result") {
    const id = typeof data.toolCallId === "string" ? data.toolCallId : entry.id;
    const index = items.findLastIndex((item) => item.kind === "tool" && item.id === id);
    const result: Tool = {
      at,
      kind: "tool",
      id,
      name: typeof data.toolName === "string" ? data.toolName : "tool",
      args: index < 0 ? undefined : (items[index] as Tool).args,
      result: textOf(data.content),
      isError: data.isError === true,
      status: "done",
    };
    if (index < 0) items.push(result);
    else items[index] = result;
    fold.open = true;
  } else if (entry.kind === "compaction") {
    fold.context = undefined;
  }
}

// `message` is the failure's words; the turn it ended is the last user message.
function failureNote(fold: Fold, message: string, code: string | undefined, at: number): Note {
  const turn = fold.items.findLast((item) => item.kind === "user");
  const toolsRan = fold.items.slice(fold.unconcluded).some((item) => item.kind === "tool");
  return {
    kind: "note",
    tone: "error",
    text: `run failed${message ? `: ${message}` : ""}`,
    at,
    ...(turn?.kind === "user" ? { resend: { text: turn.text, toolsRan } } : {}),
    ...failed(message, code),
  };
}

const copy = (fold: Fold): Fold => ({ ...fold, items: [...fold.items] });

export function foldEntries(entries: Entry[]): Fold {
  const fold = emptyFold();
  for (const entry of entries) {
    if (fold.ids.has(entry.id)) continue;
    fold.ids.add(entry.id);
    step(fold, entry);
  }
  return fold;
}

/** The fold with one more entry; the same fold when the history already held it. */
export function foldEntry(fold: Fold, entry: Entry): Fold {
  if (fold.ids.has(entry.id)) return fold;
  fold.ids.add(entry.id);
  const next = copy(fold);
  step(next, entry);
  return next;
}

/** A line the record does not hold, at the end of the conversation as it is now. */
export function foldLine(fold: Fold, item: Item): Fold {
  const next = copy(fold);
  next.items.push(item);
  return next;
}

/** How a message ended is such a line, and what the record cannot say is how the turn ended: nothing waits on an answer. */
export function foldNote(fold: Fold, item: Item): Fold {
  return { ...foldLine(fold, item), open: false };
}

/** The failure of a message that ended `failed`, unless the record already says it: its answer entry did. */
export function failureOf(fold: Fold, error: { code: string; message: string }, at: number): Item | undefined {
  const turn = fold.items.findLastIndex((item) => item.kind === "user");
  if (fold.items.slice(turn + 1).some((item) => item.kind === "note" && item.tone === "error")) return undefined;
  return failureNote(fold, error.message, error.code, at);
}

/** How a canceled message ended in the transcript, unless a line already says it. */
export function stoppedNote(fold: Fold, at: number): Item | undefined {
  const turn = fold.items.findLastIndex((item) => item.kind === "user");
  if (fold.items.slice(turn + 1).some((item) => item.kind === "note")) return undefined;
  return { kind: "note", tone: "info", text: "run stopped", at };
}

// ── What is being written, which no entry holds yet ─────────────────────────────────────────────────────────────

export interface Live {
  thinking?: { text: string; started: number; ended?: number };
  text?: { text: string; started: number };
  tools: Record<string, { started: number; progress?: string }>;
  retry?: { attempt: number; maxAttempts: number; reason: string; at: number };
}

export const noLive = (): Live => ({ tools: {} });

const stopThinking = (live: Live, now: number): Live =>
  live.thinking && live.thinking.ended === undefined ? { ...live, thinking: { ...live.thinking, ended: now } } : live;

export function liveStep(live: Live, event: SessionEvent, now: number): Live {
  switch (event.type) {
    case "delta":
      if (event.channel === "thinking")
        return { ...live, retry: undefined, thinking: { text: (live.thinking?.text ?? "") + event.text, started: live.thinking?.started ?? now } };
      return {
        ...stopThinking(live, now),
        retry: undefined,
        text: { text: (live.text?.text ?? "") + event.text, started: live.text?.started ?? now },
      };
    case "state": {
      const reply = event.session.reply;
      const next: Live = { ...live, thinking: undefined, text: undefined };
      if (reply?.thinking) next.thinking = { text: reply.thinking, started: live.thinking?.started ?? now, ...(reply.text && { ended: now }) };
      if (reply?.text) next.text = { text: reply.text, started: live.text?.started ?? now };
      return next;
    }
    case "tool_started":
      return {
        ...stopThinking(live, now),
        retry: undefined,
        tools: { ...live.tools, [event.toolCallId]: { started: now } },
      };
    case "tool_progress": {
      const known = live.tools[event.toolCallId];
      return { ...live, tools: { ...live.tools, [event.toolCallId]: { started: known?.started ?? now, progress: event.text } } };
    }
    case "retrying":
      // The next attempt starts over.
      return { ...live, thinking: undefined, text: undefined, retry: { attempt: event.attempt, maxAttempts: event.maxAttempts, reason: event.reason, at: now } };
    case "entry": {
      if (event.entry.kind === "tool_result") {
        const { [String((event.entry.data as { toolCallId?: unknown }).toolCallId)]: _done, ...tools } = live.tools;
        return { ...live, tools, retry: undefined };
      }
      if (event.entry.kind !== "assistant") return live;
      // The entry replaces what was shown of its reply. A failed one is the attempt that is being retried.
      const failedAttempt = (event.entry.data as { stop?: unknown }).stop === "failed";
      return { ...live, thinking: undefined, text: undefined, ...(failedAttempt ? {} : { retry: undefined }) };
    }
    case "done":
      return noLive();
    default:
      return live;
  }
}

const running = new WeakMap<Tool, { started?: number; progress?: string; out: Tool }>();

function inProgress(tool: Tool, live: Live): Tool {
  const known = live.tools[tool.id];
  const memo = running.get(tool);
  if (memo && memo.started === known?.started && memo.progress === known?.progress) return memo.out;
  const out: Tool = {
    ...tool,
    status: "running",
    ...(known && { started: known.started }),
    ...(known?.progress !== undefined && { result: known.progress }),
  };
  running.set(tool, { started: known?.started, progress: known?.progress, out });
  return out;
}

const cutShort = (fold: Fold, turn: Extract<Item, { kind: "user" }>): Item => ({
  kind: "note",
  tone: "error",
  text: "run cut short: no answer was recorded",
  title: "This run was cut short",
  advice: "duang or the computer stopped before an answer was recorded. What it did up to here is kept.",
  at: fold.items.at(-1)!.at,
  resend: { text: turn.text, toolsRan: fold.items.slice(fold.unconcluded).some((item) => item.kind === "tool") },
});

/** What the transcript shows: the record, with the newest turn's tools running or cut, and the reply being written. */
export function itemsOf(fold: Fold, isRunning: boolean, live: Live): Item[] {
  let record = fold;
  if (fold.failure) {
    // A failure the running turn has not answered yet is a retry waiting out its delay.
    record = copy(fold);
    if (isRunning) retried(record);
    else concluded(record, fold.failure.index);
  }
  const turn = record.items.findLastIndex((item) => item.kind === "user");
  const user = record.items[turn];
  let items = record.items;
  if (!isRunning) {
    // A conversation not running that stops mid-turn was cut with nothing recorded.
    if (record.open && user?.kind === "user") items = [...items, cutShort(record, user)];
    return items;
  }
  // Calls after the newest user message are still executing; history has no start time for them.
  items = items.map((item, index) => (index > turn && item.kind === "tool" && item.status === "interrupted" ? inProgress(item, live) : item));
  const shown: Item[] = [];
  if (live.thinking)
    shown.push({
      kind: "thinking",
      text: live.thinking.text,
      open: live.thinking.ended === undefined,
      started: live.thinking.started,
      at: live.thinking.ended ?? live.thinking.started,
    });
  if (live.text) shown.push({ kind: "assistant", text: live.text.text, open: true, at: live.text.started });
  if (live.retry) {
    // The line counting the retries so far gives way to the one for the wait in progress.
    if (isCount(items.at(-1))) items = items.slice(0, -1);
    shown.push({
      kind: "note",
      tone: "info",
      at: live.retry.at,
      text: `retrying ${live.retry.attempt}/${live.retry.maxAttempts}: ${retryReason(live.retry.reason)}`,
      reason: live.retry.reason,
      retry: live.retry.attempt,
      of: live.retry.maxAttempts,
    });
  }
  return shown.length ? [...items, ...shown] : items;
}
