import { Fragment, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  Plug,
  Swap,
  ArrowClockwise,
  ArrowDown,
  ArrowSquareOut,
  ArrowsOut,
  CaretDown,
  Check,
  Copy,
  CaretRight,
  FilePlus,
  FileText,
  FolderOpen,
  Globe,
  Info,
  MagnifyingGlass,
  PencilSimple,
  Terminal,
  X,
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";
import { stripPathSuffix } from "../shared/links.ts";
import { MarkdownCode, MarkdownLink, TranscriptActionsContext } from "./code.tsx";
import { markdownPlugins, markdownRehypePlugins, normalizeMath } from "./markdown.ts";
import {
  dayLabel,
  duration,
  firstArg,
  foldHead,
  group,
  lineOf,
  lines,
  liveEnd,
  phase,
  placeAt,
  stringify,
  summarize,
  thinkingLine,
  toolDetail,
  toolText,
  type DiffLine,
  type Item,
  type Line,
  type Place,
  type Work,
} from "./transcript.ts";
import type { SessionState } from "./conversation.ts";
import { clock } from "./time.ts";
import { Badge, Button, useCopy, type Tone } from "./ui.tsx";
import { Problem } from "./problem.tsx";

// The clock counts from when this window saw the run start, so a run reopened halfway shows none, not a wrong one.
export function RunStatus({
  items,
  status,
  started,
  heard,
  quietOnly,
  className = "",
}: {
  items: Item[];
  status: SessionState["status"] | undefined;
  started?: number;
  heard?: number;
  quietOnly?: boolean;
  className?: string;
}) {
  const { word, detail, activity } = phase(items, status);
  const elapsed = useElapsed(started, undefined);
  // A running tool may rightly be quiet for minutes, and has its own clock; only the model's silence is said.
  const quiet = useElapsed(activity === "tool" ? undefined : heard, undefined, QUIET_MS);
  if (quietOnly && !quiet) return null;
  return (
    <div className={className}>
    <div className="enter flex h-7 items-center gap-2 text-[12px]">
      <span className="bounce size-[7px] shrink-0 rounded-full bg-accent" aria-hidden />
      <span className="shimmer shrink-0">{word}</span>
      {detail && <span className={`min-w-0 truncate text-muted ${word === "thinking" ? "" : "font-mono"}`}>{detail}</span>}
      {elapsed && <span className="shrink-0 text-muted tabular-nums">· {elapsed}</span>}
      {quiet && <span className="shrink-0 text-muted tabular-nums">· no output for {quiet}</span>}
    </div>
    </div>
  );
}

// A thinking model can be quiet this long and be fine: said plainly, not as a failure.
const QUIET_MS = 30_000;

function useElapsed(started: number | undefined, ended: number | undefined, after = 0): string | undefined {
  const [now, setNow] = useState(Date.now());
  const live = started !== undefined && ended === undefined;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  if (started === undefined) return undefined;
  const ms = Math.max(0, (ended ?? now) - started);
  return ms < after ? undefined : duration(ms, live);
}

// The space above a line depends on the pair (§8): asides close up to 8, words and work 12, a change of
// speaker 32 above what someone sent and 24 below.
const ASIDE = new Set(["tool", "thinking", "note", "work", "status"]);

function gap(previous: string | undefined, kind: string): string {
  if (!previous) return "";
  if (kind === "user") return "pt-8";
  if (previous === "user") return "pt-6";
  return ASIDE.has(kind) && ASIDE.has(previous) ? "pt-2" : "pt-3";
}

const ends = (next: Line | Work | undefined, busy: boolean) => (next ? next.kind !== "work" : !busy);

const FIRST_LINES = 40;
const LINES_PER_BATCH = 15;

const linesEnd = (el: HTMLElement) => el.firstElementChild!.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop;
// Lines drawn above the view do not move this.
const fromEnd = (el: HTMLElement) => linesEnd(el) - el.scrollTop;

const drawnLines = (el: HTMLElement) => [...el.firstElementChild!.children].filter((row): row is HTMLElement => row instanceof HTMLElement && row.dataset.line !== undefined);
const top = (row: Element, el: HTMLElement) => row.getBoundingClientRect().top - el.getBoundingClientRect().top;
type Spot = { line: number; offset: number };
function spotOf(el: HTMLElement): Spot | undefined {
  const row = drawnLines(el).find((row) => row.getBoundingClientRect().bottom > el.getBoundingClientRect().top);
  return row && { line: Number(row.dataset.line), offset: top(row, el) };
}
// A line no longer drawn gives way to the next. An expanded card comes back folded, so a place past its
// folded height goes to its top.
function scrollToSpot(el: HTMLElement, place: Spot) {
  const rows = drawnLines(el);
  const row = rows.find((row) => Number(row.dataset.line) >= place.line) ?? rows.at(-1);
  if (!row) return;
  const offset = Number(row.dataset.line) === place.line && -place.offset < row.offsetHeight ? place.offset : 0;
  el.scrollTop += top(row, el) - offset;
}

const atLatest = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 40;

export function Transcript({
  items,
  waiting,
  busy,
  status,
  started,
  heard,
  bottomGap,
  resume,
  onRest,
  onRetry,
  onUsage,
  onSettings,
  onPickModel,
  onOpenLink,
  onOpenPath,
  provider,
}: {
  items: Item[];
  // `opens`: it opens the run on screen, so it reads above that run's working mark.
  waiting: { item: Item; listed: boolean; opens: boolean }[];
  busy: boolean;
  status: SessionState["status"] | undefined;
  started?: number;
  heard?: number;
  // The transcript scrolls under the floating composer, so it ends above it.
  bottomGap: number;
  resume?: Place;
  onRest: (place: Place | undefined) => void;
  onRetry?: () => void;
  onUsage: (provider: string) => void;
  onSettings: (where: "providers" | "network") => void;
  onPickModel: () => void;
  onOpenLink?: (url: string) => void;
  onOpenPath?: (path: string) => void;
  provider?: string;
}) {
  const transcriptActions = useMemo(() => ({ onOpenLink, onOpenPath }), [onOpenLink, onOpenPath]);
  // The ways on belong to the latest problem only, and only while nothing runs: an earlier one is history.
  const last = items.at(-1);
  const problem = !busy && last?.kind === "note" && last.title ? last : undefined;
  const actions = problem && (
    <>
      {problem.fix === "providers" && (
        <Button kind="secondary" size={28} onClick={() => onSettings("providers")} icon={<Plug size={12} />}>
          {provider ? `Sign in to ${provider} again` : "Model providers"}
        </Button>
      )}
      {problem.fix === "network" && (
        <Button kind="secondary" size={28} onClick={() => onSettings("network")} icon={<Globe size={12} />}>
          Network settings
        </Button>
      )}
      {problem.limit && (
        <Button kind="secondary" size={28} onClick={() => onUsage(problem.limit!)} title="Open the plan's usage page in the browser" icon={<ArrowSquareOut size={12} />}>
          View usage
        </Button>
      )}
      {problem.fix === "model" && (
        <Button kind="secondary" size={28} onClick={onPickModel} title="Choose another model, then retry" icon={<Swap size={12} />}>
          Use another model
        </Button>
      )}
      {onRetry && (
        <Button kind="secondary" size={28} onClick={onRetry} title="Send this message again as a new turn" icon={<ArrowClockwise size={12} />}>
          Retry
        </Button>
      )}
    </>
  );
  const shown = group(lines(items));
  const current = useRef(shown);
  current.current = shown;
  const placeOf = (el: HTMLElement) => {
    const spot = spotOf(el);
    return spot && placeAt(current.current, spot.line, spot.offset);
  };
  const [back] = useState((): Spot | undefined => {
    const line = resume && lineOf(shown, resume);
    return line === undefined ? undefined : { line, offset: resume!.offset };
  });
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(back === undefined);
  // Holds the place while layout settles (fonts and code blocks grow a remounted conversation), until the person scrolls.
  const restoring = useRef(back !== undefined);
  const scrolled = () => {
    restoring.current = false;
  };
  const [away, setAway] = useState(false);
  // Resizing or output growing past the viewport changes the answer without a scroll event.
  const check = () => {
    const el = box.current;
    if (!el) return;
    if (restoring.current) {
      scrollToSpot(el, back!);
      follow.current = false;
      setAway(true);
      return;
    }
    follow.current = atLatest(el);
    setAway(!follow.current);
    onRest(follow.current ? undefined : placeOf(el));
  };
  // Before the first paint, so the conversation is never seen at the bottom first.
  useLayoutEffect(() => {
    if (back !== undefined) scrollToSpot(box.current!, back);
    // A scroll event that has not fired yet cannot tell the place, so it is read here, while still attached.
    return () => {
      const el = box.current;
      if (el && !restoring.current) onRest(atLatest(el) ? undefined : placeOf(el));
    };
  }, []);

  const queue = (opening: boolean) =>
    waiting.map(({ item, listed, opens }, index) =>
      opens === opening ? (
        <div key={index} className="enter pt-8">
          <Message item={item} waiting={listed ? "queued" : "sending"} />
        </div>
      ) : null,
    );

  const end = liveEnd(shown, busy, waiting.some(({ opens }) => opens));
  const live = (
    <RunStatus items={items} status={status} started={started} heard={heard} quietOnly={end.quietOnly} className={gap(end.above, "status")} />
  );
  // The view remounts per conversation with history loaded: rows present at mount are not new, so they do not `enter`.
  const history = useRef(shown.length);
  // Long conversations draw the end first and older lines above in idle batches (150 turns froze about a second).
  // Each batch restores the distance from the end itself: Chromium's scroll anchoring fails at `scrollTop` 0.
  // `flushSync` keeps any scroll from coming between reading the place and restoring it.
  const [from, setFrom] = useState(() => Math.min(back?.line ?? Infinity, Math.max(0, shown.length - FIRST_LINES)));
  useEffect(() => {
    if (from === 0) return;
    const id = requestIdleCallback(
      () => {
        const el = box.current!;
        const place = fromEnd(el);
        flushSync(() => setFrom((at) => Math.max(0, at - LINES_PER_BATCH)));
        el.scrollTop = linesEnd(el) - place;
        drewAbove.current = true;
      },
      { timeout: 100 },
    );
    return () => cancelIdleCallback(id);
  }, [from]);
  // The observer runs after the batch, which already put the view back: it must not read that growth as new content.
  const drewAbove = useRef(false);

  useEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
    check();
  }, [items, waiting, busy]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    // Content grows after layout (fonts, code blocks) with no scroll event: a view at the end stays there, one holding
    // a place keeps it. Judged against the height before this growth; growth from a batch above is skipped.
    let height = 0;
    const grown = new ResizeObserver(() => {
      const wasAtEnd = height - el.scrollTop - el.clientHeight < 40;
      height = el.scrollHeight;
      const above = drewAbove.current;
      drewAbove.current = false;
      if (restoring.current) check();
      else if (wasAtEnd && !above) {
        el.scrollTop = el.scrollHeight;
        check();
      }
    });
    if (el.firstElementChild) grown.observe(el.firstElementChild);
    return () => {
      observer.disconnect();
      grown.disconnect();
    };
  }, []);

  return (
    <TranscriptActionsContext.Provider value={transcriptActions}>
    <div className="relative flex-1 min-h-0 flex flex-col">
      {away && (
        <Button
          kind="secondary"
          size={32}
          onClick={() => {
            const el = box.current;
            if (!el) return;
            scrolled();
            // Not smooth: each frame fires `scroll` short of the bottom, so the button flickers back.
            el.scrollTop = el.scrollHeight;
            check();
          }}
          aria-label="Back to the latest"
          title="Back to the latest"
          icon={<ArrowDown size={16} />}
          className="pop absolute right-6 z-10 bg-surface shadow-lg"
          style={{ bottom: bottomGap - 8 }}
        />
      )}
    <div
      ref={box}
      // Focusable, so the transcript can be scrolled from the keyboard (§11).
      tabIndex={0}
      role="region"
      aria-label="Transcript"
      onScroll={check}
      // Person-driven only, unlike scroll events from layout and restoring.
      onWheel={scrolled}
      onKeyDown={scrolled}
      onPointerDown={scrolled}
      onTouchStart={scrolled}
      // The scrollbar gutter is reserved on both sides so the column centres where the composer does.
      className="flex-1 min-h-0 overflow-y-auto px-6 pt-16 [scrollbar-gutter:stable_both-edges]"
      style={{ paddingBottom: bottomGap }}
    >
      <div className="column">
        {shown.map((line, index, all) =>
          index < from || line === end.hidden ? null : line.kind === "day" ? (
            <div key={index} data-line={index} className="flex items-center gap-3 py-4 text-[11px] text-muted">
              <span className="h-px flex-1 bg-stroke" />
              {dayLabel(line.at)}
              <span className="h-px flex-1 bg-stroke" />
            </div>
          ) : (
            // `enter` runs once per element; a streaming answer re-renders the same node.
            <div key={index} data-line={index} className={`${index >= history.current ? "enter" : ""} ${gap(all[index - 1]?.kind, line.kind)}`}>
              {line.kind === "work" ? (
                <SettledWork work={line} live={line === end.block ? live : undefined} />
              ) : (
                <SettledMessage item={line} ends={ends(all[index + 1], busy)} actions={line === problem ? actions : undefined} />
              )}
            </div>
          ),
        )}
        {queue(true)}
        {end.status && live}
        {queue(false)}
      </div>
    </div>
    </div>
    </TranscriptActionsContext.Provider>
  );
}

// Without this every streamed word re-parsed every answer's markdown: 150 turns streamed at about 8 fps.
// `group` rebuilds work blocks each render, so compare their items.
const SettledMessage = memo(Message);
const SettledWork = memo(
  WorkBlock,
  (before, after) =>
    before.live === after.live &&
    before.work.items.length === after.work.items.length &&
    before.work.items.every((item, index) => item === after.work.items[index]),
);

// Only `a` and `code`: Streamdown's own `pre` marks fenced blocks, and replacing it makes every block inline.
const markdownComponents = { a: MarkdownLink, code: MarkdownCode };

const markdownControls = { table: { download: false } };
const markdownLinkSafety = { enabled: false };

// Streamdown's table controls are Lucide; match the code block's Phosphor icons.
const markdownIcons = { CopyIcon: Copy, CheckIcon: Check, Maximize2Icon: ArrowsOut, XIcon: X };

// Streamdown caps tables at 300px with an inner scroll, which steals the wheel; 0 removes the cap.
const TABLE_FULL_HEIGHT = 0;

export function Message({
  item,
  waiting,
  ends = true,
  actions,
}: {
  item: Item;
  actions?: ReactNode;
  waiting?: "queued" | "sending";
  ends?: boolean;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex flex-col items-end gap-1">
          <div
            className={`bubble max-w-[80%] rounded-float rounded-br-[4px] bg-accent-weak px-3.5 py-2 whitespace-pre-wrap ${
              item.steered ? "border-r-2 border-accent" : ""
            } ${waiting ? "opacity-60" : ""}`}
          >
            {item.text}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted">
            {waiting ? (
              <span>{waiting}</span>
            ) : (
              <>
                {item.steered && <span className="text-accent">joined the run</span>}
                <span>{clock(item.at)}</span>
              </>
            )}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="group/msg">
          <div className="md">
            <Streamdown
              caret="block"
              components={markdownComponents}
              controls={markdownControls}
              icons={markdownIcons}
              isAnimating={item.open}
              linkSafety={markdownLinkSafety}
              parseIncompleteMarkdown={item.open}
              plugins={markdownPlugins}
              rehypePlugins={markdownRehypePlugins}
              tableMaxHeight={TABLE_FULL_HEIGHT}
            >
              {normalizeMath(item.text)}
            </Streamdown>
          </div>
          {!item.open && ends && <Footer text={item.text} at={item.at} />}
        </div>
      );
    case "thinking": {
      const seconds = Math.round((item.at - item.started) / 1000);
      const trail = thinkingLine(item.text, item.open);
      return (
        <details className="group text-muted text-[12px]">
          <summary className="cursor-default select-none flex h-7 items-center gap-2">
            <CaretRight size={11} className="shrink-0 transition-transform group-open:rotate-90" />
            {/* Still streaming means the seconds are not final yet, so the label sweeps instead of
                counting: the movement is the answer to "is it stuck". */}
            <span className={`shrink-0 ${item.open ? "shimmer" : ""}`}>
              {seconds > 0 ? `thinking · ${seconds}s` : "thinking"}
            </span>
            <span className="truncate opacity-60 group-open:hidden">{trail}</span>
          </summary>
          <div className="mb-1 ml-[5px] whitespace-pre-wrap border-l border-stroke pl-3 leading-relaxed">
            {item.text}
          </div>
        </details>
      );
    }
    case "note":
      if (item.title)
        return <Problem tone={item.tone} title={item.title} advice={item.advice} reason={item.reason} actions={actions} />;
      return (
        <div title={item.reason} className="flex items-center justify-center gap-1.5 text-[12px] text-muted">
          <Info size={12} className="shrink-0" />
          <span className="min-w-0 break-words">{item.text}</span>
        </div>
      );
    case "tool":
      return <Tool item={item} />;
  }
}

function Footer({ text, at }: { text: string; at: number }) {
  const { copied, failed, copy } = useCopy(text);
  return (
    <div className="mt-1.5 flex h-5 items-center gap-1 text-[11px] text-muted">
      <span className="tabular-nums">{clock(at)}</span>
      {failed && <span className="text-danger">could not copy: {failed}</span>}
      <Button
        kind="ghost"
        size={28}
        aria-label={copied ? "Copied" : "Copy message"}
        title={failed ?? "Copy this answer"}
        icon={copied ? <Check size={13} /> : <Copy size={13} />}
        className={`transition-opacity ${failed ? "" : "opacity-0"} group-hover/msg:opacity-100 focus-visible:opacity-100`}
        onClick={copy}
      />
    </div>
  );
}

const isLone = (line: Line | Work | undefined) => line?.kind === "work" && line.items.length === 1;

// Stays closed while it grows: the live status says what the run is on. A card opened while the call stood
// alone keeps the block open once it folds.
export function WorkBlock({ work, live }: { work: Work; live?: ReactNode }) {
  const lone = isLone(work) && !live;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const el = box.current!;
    // `toggle` does not bubble, so an inner card opening is heard in the capture phase.
    const heard = (event: Event) => {
      if (event.target !== el && (event.target as HTMLDetailsElement).open) setOpen(true);
    };
    el.addEventListener("toggle", heard, true);
    return () => el.removeEventListener("toggle", heard, true);
  }, []);
  return (
    <details
      ref={box}
      open={lone || open}
      onToggle={(event) => !lone && setOpen(event.currentTarget.open)}
      className="group/work"
    >
      <summary
        hidden={lone}
        className="cursor-default select-none flex h-7 items-center gap-2 text-[12px] text-muted transition-colors hover:text-text"
      >
        <CaretRight size={11} className="shrink-0 transition-transform group-open/work:rotate-90" />
        {live ?? <span className="truncate">{summarize(work.items)}</span>}
      </summary>
      <div className={lone ? "" : "mt-1 ml-[5px] space-y-0.5 border-l border-stroke pl-3.5"}>
        {work.items.map((item, index) => (
          <Message key={index} item={item} />
        ))}
      </div>
    </details>
  );
}

const toolIcons: Record<string, typeof Terminal> = {
  bash: Terminal,
  read: FileText,
  write: FilePlus,
  edit: PencilSimple,
  grep: MagnifyingGlass,
  find: MagnifyingGlass,
  ls: FolderOpen,
  fetch: Globe,
};

// A tool that worked shows nothing (§9): with every other outcome named, absence is unambiguous.
function toolState(item: Extract<Item, { kind: "tool" }>): { word: string; tone: Tone } | undefined {
  if (item.status === "interrupted") return { word: "stopped", tone: "muted" };
  if (item.isError) return { word: "failed", tone: "danger" };
  if (item.status === "running") return { word: "running", tone: "accent" };
  return undefined;
}

export function Tool({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const { onOpenPath } = useContext(TranscriptActionsContext);
  const summary = firstArg(item.args);
  const detail = toolDetail(item.name, item.args);
  const path = detail.path;
  const state = toolState(item);
  const elapsed = useElapsed(item.started, item.ended);
  const Icon = toolIcons[item.name] ?? Terminal;
  const mark = item.isError ? "text-danger" : item.status === "running" ? "text-accent" : "text-muted";
  const output = item.result !== undefined ? toolText(item.result) : undefined;
  const showOutput =
    output !== undefined &&
    (item.isError ||
      (detail.kind === "edit"
        ? !/^Successfully replaced \d+ block\(s\) in /.test(output)
        : detail.kind === "write"
          ? !/^Successfully wrote (?:to |\d+ bytes to )/.test(output)
          : true));
  return (
    // The negative margin lets the hover highlight extend past the text while the command keeps the left edge.
    <details className="group -mx-2.5 rounded-card open:bg-surface open:ring-1 open:ring-stroke">
      <summary className="cursor-default select-none flex items-center gap-2 rounded-card px-2.5 h-7 text-[12px] hover:bg-hover group-open:rounded-b-none">
        <CaretRight size={11} className="shrink-0 text-muted transition-transform group-open:rotate-90" />
        <Icon size={14} className={`shrink-0 ${mark}`} />
        <span className="shrink-0 text-muted">{item.name}</span>
        <span className="font-mono truncate">{summary}</span>
        {path && onOpenPath && (
          <button
            type="button"
            aria-label={`Show ${stripPathSuffix(path)} in Finder`}
            title={`Show ${stripPathSuffix(path)} in Finder`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenPath(path);
            }}
            className="ml-auto shrink-0 rounded-[4px] p-1 text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-surface-2 hover:text-text focus-visible:opacity-100"
          >
            <FolderOpen size={13} />
          </button>
        )}
        {state && (
          <Badge tone={state.tone} pulse={item.status === "running"} className="shrink-0">
            {state.word}
          </Badge>
        )}
        {elapsed && <span className="shrink-0 text-muted tabular-nums">{elapsed}</span>}
      </summary>
      <div className="border-t border-stroke px-2.5 py-2.5 space-y-2.5 text-[12px]">
        {detail.kind === "edit" ? (
          <>
            {path && path !== summary && <PathHeader path={path} onOpenPath={onOpenPath} />}
            <DiffHunks hunks={detail.hunks} />
          </>
        ) : detail.kind === "write" ? (
          <>
            {path && path !== summary && <PathHeader path={path} onOpenPath={onOpenPath} />}
            <Output text={detail.content} />
          </>
        ) : (
          <Args args={item.args} summary={summary} onOpenPath={onOpenPath} />
        )}
        {showOutput && <Output text={output} isError={item.isError} />}
      </div>
    </details>
  );
}

function PathHeader({ path, onOpenPath }: { path: string; onOpenPath?: (path: string) => void }) {
  if (!onOpenPath) return <div className="font-mono break-all text-muted">{path}</div>;
  return (
    <button
      type="button"
      title={`Show ${stripPathSuffix(path)} in Finder`}
      onClick={() => onOpenPath(path)}
      className="block max-w-full truncate text-left font-mono text-muted underline decoration-stroke underline-offset-2 transition-colors hover:text-text hover:decoration-accent"
    >
      {path}
    </button>
  );
}

const DIFF_FOLD_LINES = 12;

function DiffHunks({ hunks }: { hunks: DiffLine[][] }) {
  const [open, setOpen] = useState(false);
  const flat: (DiffLine | { kind: "gap" })[] = [];
  for (let index = 0; index < hunks.length; index++) {
    if (index > 0) flat.push({ kind: "gap" });
    flat.push(...hunks[index]!);
  }
  const hidden = flat.length > DIFF_FOLD_LINES ? flat.length - DIFF_FOLD_LINES : 0;
  const shown = hidden > 0 && !open ? flat.slice(0, DIFF_FOLD_LINES) : flat;
  return (
    <div>
      <div className="overflow-x-auto rounded-card bg-surface-2/50 py-1 font-mono leading-relaxed">
        {shown.map((line, index) =>
          line.kind === "gap" ? (
            <div key={index} className="my-1 border-t border-stroke" />
          ) : (
            <div
              key={index}
              className={`flex px-2 whitespace-pre ${
                line.kind === "remove"
                  ? "bg-danger/10 text-danger"
                  : line.kind === "add"
                    ? "bg-success/10 text-success"
                    : "text-muted"
              }`}
            >
              <span className="w-4 shrink-0 select-none opacity-70">
                {line.kind === "remove" ? "−" : line.kind === "add" ? "+" : " "}
              </span>
              <span className="min-w-0">{line.text || " "}</span>
            </div>
          ),
        )}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          className="focus-inset -mx-2.5 -mb-2.5 mt-2 flex h-7 w-[calc(100%+1.25rem)] items-center justify-center gap-1.5 rounded-b-card border-t border-stroke text-[11px] text-muted transition-colors hover:bg-hover hover:text-text"
          onClick={() => setOpen(!open)}
        >
          <CaretDown size={10} className={`transition-transform ${open ? "rotate-180" : ""}`} />
          {open ? "show less" : `${hidden} more lines`}
        </button>
      )}
    </div>
  );
}

function Args({ args, summary, onOpenPath }: { args: unknown; summary: string; onOpenPath?: (path: string) => void }) {
  if (args === undefined || args === null) return null;
  if (typeof args !== "object") return <pre className="font-mono whitespace-pre-wrap break-all">{stringify(args)}</pre>;
  const entries = Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0 || (entries.length === 1 && entries[0]![1] === summary)) return null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      {entries.map(([key, value]) => (
        <Fragment key={key}>
          <dt className="text-muted">{key}</dt>
          {key === "path" && typeof value === "string" && onOpenPath ? (
            <dd className="font-mono whitespace-pre-wrap break-all">
              <button
                type="button"
                title={`Show ${stripPathSuffix(value)} in Finder`}
                onClick={() => onOpenPath(value)}
                className="text-left underline decoration-stroke underline-offset-2 transition-colors hover:text-text hover:decoration-accent"
              >
                {value}
              </button>
            </dd>
          ) : (
            <Value text={stringify(value)} />
          )}
        </Fragment>
      ))}
    </dl>
  );
}

function Value({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const head = foldHead(text);
  return (
    <dd className="font-mono whitespace-pre-wrap break-all">
      {head !== undefined && !open ? `${head}…` : text}
      {head !== undefined && (
        <button
          type="button"
          className="ml-1.5 font-sans text-[11px] text-muted transition-colors hover:text-text"
          onClick={() => setOpen(!open)}
        >
          {open ? "show less" : "show all"}
        </button>
      )}
    </dd>
  );
}

function Output({ text, isError }: { text: string; isError?: boolean }) {
  const [open, setOpen] = useState(false);
  const head = foldHead(text);
  // Cut mid-line, the fold hides characters rather than lines, and "0 more lines" would be a lie.
  const hidden = head === undefined ? 0 : text.split("\n").length - head.split("\n").length;
  return (
    <div>
      {/* The error rule is on the text: the footer below must reach both edges of the card. */}
      <pre
        className={`font-mono whitespace-pre-wrap break-all leading-relaxed ${
          isError ? "border-l-2 border-danger pl-2.5 text-danger" : ""
        }`}
      >
        {head !== undefined && !open ? head : text}
      </pre>
      {head !== undefined && (
        // Negative margins reach out of the padded body; a button's auto width would shrink to its label.
        <button
          type="button"
          className="focus-inset -mx-2.5 -mb-2.5 mt-2 flex h-7 w-[calc(100%+1.25rem)] items-center justify-center gap-1.5 rounded-b-card border-t border-stroke text-[11px] text-muted transition-colors hover:bg-hover hover:text-text"
          onClick={() => setOpen(!open)}
        >
          <CaretDown size={10} className={`transition-transform ${open ? "rotate-180" : ""}`} />
          {open ? "show less" : hidden > 0 ? `${hidden} more lines` : "show the rest"}
        </button>
      )}
    </div>
  );
}
