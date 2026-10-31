import { explainRunFailure, recognise, type Fix } from "./problems.ts";

// Required, not optional: day separators and message times read it, and a producer that forgets it must not compile.
type At = { at: number };

export type Item = At &
  ({ kind: "user"; text: string; steered?: boolean; entryId?: string; messageId?: string; opens?: boolean }
  | { kind: "assistant"; text: string; open: boolean }
  // `started` survives the restamp of `at` on settling; "thought for 8s" counts from the first token.
  | { kind: "thinking"; text: string; open: boolean; started: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: unknown;
      result?: unknown;
      isError?: boolean;
      status: "running" | "done" | "interrupted";
      // Live only: history carries when the call was announced and its result written, not how long it ran.
      started?: number;
      ended?: number;
    }
  // With a `title`: a problem drawn as a card. Without: a quiet line; a stop or retry is not an error.
  // `resend`: Retry's message, and whether that run had started a tool (sending again may repeat it).
  | {
      kind: "note";
      tone: "info" | "warning" | "error";
      text: string;
      title?: string;
      advice?: string;
      reason?: string;
      fix?: Fix;
      resend?: { text: string; toolsRan: boolean };
      limit?: string;
      retry?: number;
      of?: number;
    });

// Never a failure's ending: a retrying run goes on.
export const retryReason = (reason: string) => {
  const title = recognise(reason)?.title;
  return title ? title.charAt(0).toLowerCase() + title.slice(1) : reason.split("\n")[0]!;
};

const isRetry = (item: Item | undefined): item is Extract<Item, { kind: "note" }> & { retry: number } =>
  item?.kind === "note" && !!item.retry;

export function failed(reason: string, code?: string) {
  // OpenAI's documented code for a ChatGPT plan's limit, which pi passes on in the run's error.
  if (reason.includes("subscription_sharing_usage_limit_exceeded"))
    return {
      title: "Your ChatGPT plan has reached its limit",
      advice: "Its usage page says when it resets. Until then, another model can take the message.",
      reason,
      limit: "openai",
      fix: "model" as const,
    };
  return { ...explainRunFailure(reason, code), reason };
}

// Crossing the calendar year earns the year: read in January, `Dec 25` looks like this year's.
export function dayLabel(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const days = Math.round((midnight.getTime() - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}


export type UserItem = Extract<Item, { kind: "user" }>;

// A message sent while the conversation is running joins that run; one sent to an idle conversation opens it.
export const opensRun = (status: "idle" | "running" | undefined): boolean => status !== "running";

// `listed`: FastAgent holds it (it has a message id). `opens`: reads above the run's working mark, since that
// work is what it asked for.
export function queueView(waiting: UserItem[]): { item: UserItem; listed: boolean; opens: boolean }[] {
  return waiting.map((item) => ({ item, listed: item.messageId !== undefined, opens: item.opens === true }));
}

export type Line = Item | { kind: "day"; at: number };

// Counted from the turn's opening message: a conversation read back from history loses lines only this window
// showed ("Not sent", `ran /cmd`), so counting from the start would come back off by those.
export type Place = { turn?: string; row: number; offset: number };

export function placeAt(shown: (Line | Work)[], index: number, offset: number): Place {
  for (let at = index; at >= 0; at--) {
    const line = shown[at]!;
    if (line.kind === "user" && line.entryId !== undefined) return { turn: line.entryId, row: index - at, offset };
  }
  return { row: index, offset };
}

export function lineOf(shown: (Line | Work)[], place: Place): number | undefined {
  if (place.turn === undefined) return place.row;
  const at = shown.findIndex((line) => line.kind === "user" && line.entryId === place.turn);
  return at === -1 ? undefined : at + place.row;
}

export function lines(items: Item[]): Line[] {
  const out: Line[] = [];
  let day: string | undefined;
  for (const item of items) {
    const stamp = new Date(item.at).toDateString();
    if (day !== undefined && stamp !== day) out.push({ kind: "day", at: item.at });
    day = stamp;
    out.push(item);
  }
  return out;
}

type Tool = Extract<Item, { kind: "tool" }>;
type Thinking = Extract<Item, { kind: "thinking" }>;

export type Work = { kind: "work"; items: (Tool | Thinking)[] };

// A lone call is a block too, so it stays the same element when the next call joins it and an open card
// does not close under the reader.
export function group(lines: Line[]): (Line | Work)[] {
  const out: (Line | Work)[] = [];
  for (const line of lines) {
    const previous = out.at(-1);
    if (line.kind !== "tool" && line.kind !== "thinking") out.push(line);
    else if (previous?.kind === "work") previous.items.push(line);
    else out.push({ kind: "work", items: [line] });
  }
  return out;
}

// The status is drawn in the newest line when that line is the step itself, never beside a line saying the same.
export function liveEnd(
  shown: (Line | Work)[],
  busy: boolean,
  opening: boolean,
): { status: boolean; block?: Work; hidden?: Line; quietOnly: boolean; above?: string } {
  const end = shown.at(-1);
  const now = busy && !opening ? end : undefined;
  const block =
    now?.kind === "work" &&
    now.items.some((item) => (item.kind === "tool" && item.status === "running") || (item.kind === "thinking" && item.open))
      ? now
      : undefined;
  const hidden = now?.kind === "note" && now.of !== undefined ? now : undefined;
  return {
    status: busy && !block,
    ...(block && { block }),
    ...(hidden && { hidden }),
    quietOnly: now?.kind === "assistant" && now.open,
    above: opening ? "user" : (hidden ? shown.at(-2) : end)?.kind,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const WORK = [
  { tools: ["read"], doing: "reading", did: (n: number) => `read ${plural(n, "file")}`, distinct: true },
  { tools: ["grep", "find", "ls"], doing: "searching", did: (n: number) => `searched ${n === 1 ? "once" : `${n} times`}` },
  { tools: ["edit", "write"], doing: "editing", did: (n: number) => `changed ${plural(n, "file")}`, distinct: true },
  { tools: ["bash"], doing: "running", did: (n: number) => `ran ${plural(n, "command")}` },
  { tools: ["fetch"], doing: "fetching", did: (n: number) => `fetched ${plural(n, "page")}` },
];

// A failed call is not counted apart: the agent reads its own failures. A call that never finished is
// (`1 stopped`): reopened from history, nothing else says the run was cut.
export function summarize(items: Work["items"]): string {
  const all = items.filter((item): item is Tool => item.kind === "tool");
  const tools = all.filter((tool) => tool.status !== "running");
  // How long, when it is known and worth saying; read back from history it is not, and the thought still counts.
  const thoughts = items.filter((item): item is Thinking => item.kind === "thinking" && !item.open);
  const thought = thoughts.reduce((ms, item) => ms + item.at - item.started, 0);
  const parts = thoughts.length ? [thought >= 1000 ? `thought ${Math.round(thought / 1000)}s` : "thought"] : [];
  for (const kind of WORK) {
    const mine = tools.filter((tool) => kind.tools.includes(tool.name));
    const n = kind.distinct ? new Set(mine.map((tool) => (tool.args as { path?: unknown } | undefined)?.path ?? tool.id)).size : mine.length;
    if (n) parts.push(kind.did(n));
  }
  const others = new Map<string, number>();
  for (const tool of tools) if (!WORK.some((kind) => kind.tools.includes(tool.name))) others.set(tool.name, (others.get(tool.name) ?? 0) + 1);
  for (const [name, n] of others) parts.push(`used ${name}${n > 1 ? ` ×${n}` : ""}`);
  const stopped = tools.filter((tool) => tool.status === "interrupted").length;
  if (stopped) parts.push(`${stopped} stopped`);
  const running = all.length - tools.length;
  if (running) parts.push(`${running} running`);
  return parts.join(", ") || "thought";
}

// A streaming block's last line is usually a fragment, so show its last complete line. Unspaced scripts
// (Chinese, Japanese) show the text so far; a spaced script's lone first word may be half-written.
export function thinkingLine(text: string, streaming = false): string {
  const last = (lines: string) => lines.trim().split("\n").at(-1) ?? "";
  if (!streaming || text.endsWith("\n")) return last(text);
  const complete = last(text.slice(0, Math.max(0, text.lastIndexOf("\n"))));
  if (complete) return complete;
  const words = text.trim();
  const space = words.lastIndexOf(" ");
  if (space >= 0) return words.slice(0, space);
  return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(words) ? words : "";
}

export type Activity = "thinking" | "tool" | "answering";

export function phase(
  items: Item[],
  status: "idle" | "running" | undefined,
): { word: string; detail?: string; activity: Activity } {
  if (status !== "running") return { word: "starting", activity: "thinking" };
  const running = items.filter((item): item is Tool => item.kind === "tool" && item.status === "running");
  if (running.length > 1) return { word: `running ${running.length} tools`, activity: "tool" };
  const tool = running[0];
  if (tool) {
    const kind = WORK.find((candidate) => candidate.tools.includes(tool.name));
    const arg = firstArg(tool.args);
    return kind
      ? { word: kind.doing, detail: arg, activity: "tool" }
      : { word: "running", detail: `${tool.name} ${arg}`.trim(), activity: "tool" };
  }
  const last = items.at(-1);
  if (last?.kind === "assistant" && last.open) return { word: "answering", activity: "answering" };
  // Waiting out the agent's retry delay is not thinking: it says the retry, and what it is retrying.
  if (isRetry(last) && last.of !== undefined)
    return { word: `retrying ${last.retry}/${last.of}`, detail: retryReason(last.reason ?? ""), activity: "thinking" };
  const thought = last?.kind === "thinking" && last.open ? thinkingLine(last.text, true) || undefined : undefined;
  return { word: "thinking", detail: thought, activity: "thinking" };
}

// Results arrive MCP-shaped (`{ content: [{ type: "text", text }] }`). Anything but text parts keeps its JSON:
// a result nobody can see is worse than an ugly one.
export function toolText(result: unknown): string {
  let value = result;
  // Depth-limited: the envelope is one or two deep, and a cycle would hang the renderer.
  for (let depth = 0; depth < 3; depth++) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const parts = value.map((part) =>
        part && typeof part === "object" && (part as { type?: unknown }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : undefined,
      );
      return parts.every((part) => part !== undefined) ? parts.join("\n") : stringify(result);
    }
    if (value && typeof value === "object" && "content" in value) {
      value = (value as { content: unknown }).content;
      continue;
    }
    break;
  }
  return stringify(result);
}

// Characters count too: minified JSON has one line and no ceiling. 1500 characters is about twelve lines.
export function foldHead(text: string): string | undefined {
  const head = text.split("\n").slice(0, 12).join("\n").slice(0, 1_500);
  return head.length < text.length ? head : undefined;
}

// A running clock ticks once a second, so tenths would claim a precision it does not have.
export function duration(ms: number, running = false): string {
  const seconds = ms / 1000;
  if (seconds < 60) return running ? `${Math.floor(seconds)}s` : `${seconds.toFixed(1)}s`;
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${total % 60}s`;
}

export function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function firstArg(args: unknown): string {
  if (typeof args === "string") return args;
  if (!args || typeof args !== "object") return "";
  const entry = Object.entries(args as Record<string, unknown>).find(([, value]) => typeof value === "string");
  if (!entry) return "";
  const text = entry[1] as string;
  // Only a path argument is a path; a command starting with / still needs its executable.
  if (entry[0] === "path" && text.startsWith("/")) return `…/${text.split("/").filter(Boolean).slice(-2).join("/")}`;
  return text.length <= 72 ? text : `${text.slice(0, 71)}…`;
}

// Settled thinking is not output and is passed over. While calls run, the newest still running is quoted,
// not a later one already finished (`ls` beside a running `sleep`).
export function previewOf(items: Item[]): { text: string; at: number } | undefined {
  const running = items.findLastIndex((item) => item.kind === "tool" && item.status === "running");
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (running >= 0 && i > running && item.kind === "tool") continue;
    const text =
      item.kind === "user"
        ? `You: ${item.text}`
        : item.kind === "assistant"
          ? item.text
          : item.kind === "note"
            ? // A problem is quoted by what it means, not by the provider's raw words.
              item.title ?? item.text
          : item.kind === "tool"
            ? `${item.name} ${firstArg(item.args)}`
            : item.kind === "thinking" && item.open
              ? ["thinking", thinkingLine(item.text, true)].filter(Boolean).join(": ")
              : "";
    const plain = text
      .replace(/^(#{1,6}|>)\s*/gm, "")
      .replace(/```\w*|`|\*\*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (plain) return { text: plain, at: item.at };
  }
  return undefined;
}

