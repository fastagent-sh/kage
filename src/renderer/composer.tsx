import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, CaretDown, Check, MagnifyingGlass, Plug, Prohibit, Stop } from "@phosphor-icons/react";
import { complete, completionQuery, matches } from "./commands.ts";
import { Button } from "./ui.tsx";
import type { Store, View } from "./store.ts";
import { home } from "./paths.ts";
import { tokens } from "./usage.ts";
import { Problem } from "./problem.tsx";
import { unavailableNotice } from "./problems.ts";
import { modelIdOf, pickerModels, providerOf } from "./catalog.ts";
import type { ModelAsk } from "./store.ts";

// The picker's notice is only about a model that cannot run: a conversation with no model is not a problem.
type ModelProblem = Extract<ModelAsk, { reason: "gone" | "refused" }>;
import type { Models } from "../preload/index.ts";

const LEVELS: Record<string, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const levelName = (level: string) => LEVELS[level] ?? level;

// Choosing writes a durable entry, so it is explicit: buttons, not a radio group that chooses at every
// stop the arrow keys cross. The track shows only what the runtime reports.
// `level` is absent while the conversation follows the agent's own setting, which FastAgent does not report.
function Effort({ levels, level, onPick }: { levels: readonly string[]; level?: string; onPick: (level: string) => void }) {
  const stops = useRef<(HTMLButtonElement | null)[]>([]);
  const index = level === undefined ? -1 : levels.indexOf(level);
  const focusStop = (to: number) => stops.current[Math.min(levels.length - 1, Math.max(0, to))]?.focus();
  return (
    <div className="px-3 pt-3 pb-2">
      <div className="mb-2 flex items-baseline justify-between text-[13px]">
        <span className="text-muted">Effort</span>
        <span className="font-semibold">{level === undefined ? "Agent default" : levelName(level)}</span>
      </div>
      <div
        role="radiogroup"
        aria-label="Effort"
        className="relative flex h-6 items-center justify-between"
        onKeyDown={(event) => {
          const at = stops.current.indexOf(document.activeElement as HTMLButtonElement);
          const to = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: levels.length - 1 }[event.key];
          if (to === undefined || at < 0) return;
          event.preventDefault();
          focusStop(to);
        }}
      >
        <span className="absolute inset-x-0 h-2 rounded-full bg-hover" />
        {/* Stops are 20px wide. */}
        <span
          className="absolute left-0 h-2 rounded-full bg-accent-fill"
          style={{ width: index < 0 ? 0 : `calc((100% - 20px) * ${levels.length > 1 ? index / (levels.length - 1) : 0} + 10px)` }}
        />
        {levels.map((name, stop) => (
          <button
            key={name}
            ref={(el) => {
              stops.current[stop] = el;
            }}
            type="button"
            role="radio"
            aria-checked={name === level}
            aria-label={levelName(name)}
            title={levelName(name)}
            // One tab stop for the group, on the chosen level, as a radio group has.
            tabIndex={name === (level ?? levels[0]) ? 0 : -1}
            onClick={() => name !== level && onPick(name)}
            className={`relative size-5 shrink-0 cursor-pointer rounded-full before:absolute before:top-1/2 before:left-1/2 before:size-1.5 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full ${stop < index ? "before:bg-white/70" : "before:bg-muted/60"} aria-checked:bg-white aria-checked:shadow-[0_1px_4px_rgb(0_0_0/0.35)] aria-checked:before:hidden focus-visible:outline-2 focus-visible:outline-accent`}
          />
        ))}
      </div>
    </div>
  );
}

function ModelPicker({
  view,
  store,
  current,
  thinking,
  ask,
  onClose,
  onProviders,
}: {
  view: View;
  store: Store;
  current?: string;
  thinking?: { level?: string; levels?: readonly string[] };
  ask?: ModelProblem;
  onClose: () => void;
  onProviders: () => void;
}) {
  const { models, modelsError: error } = view;
  const onRetry = () => void store.loadModels();
  const [filter, setFilter] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const close = () => {
    // Close while still connected so Chromium can restore focus before React removes the dialog.
    dialog.current?.close();
    onClose();
  };

  useEffect(() => {
    const el = dialog.current!;
    const anchor = el.parentElement!.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(anchor.right - 300, window.innerWidth - 308))}px`;
    el.style.bottom = `${window.innerHeight - anchor.top + 8}px`;
    // Tall enough for a dozen rows and the effort track; the list scrolls, the search and the track do not.
    el.style.maxHeight = `${Math.min(480, Math.max(160, anchor.top - 16))}px`;
    el.showModal();
    // showModal() moves focus itself after React's autoFocus.
    el.querySelector("input")?.focus();
    return () => el.close();
  }, []);
  const query = filter.toLowerCase();
  const matching = pickerModels(models ?? [], current)
    .filter((m) => m.spec.toLowerCase().includes(query) || !!m.name?.toLowerCase().includes(query))
    .sort((a, b) => Number(b.spec === current) - Number(a.spec === current));
  const shown = matching.slice(0, 60);
  // Cut off after grouping, a provider past the limit would not even show its heading: say so.
  const hidden = matching.length - shown.length;
  const groups = new Map<string, Models>();
  for (const model of shown) {
    const provider = providerOf(model.spec);
    groups.set(provider, [...(groups.get(provider) ?? []), model]);
  }

  return (
    <dialog
      ref={dialog}
      aria-label="Choose a model"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      // The window-level Escape handler behind it stops runs.
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          close();
      }}
      className="popover fixed m-0 top-auto right-auto w-[300px] flex-col overflow-hidden p-0 text-text open:flex backdrop:bg-transparent"
    >
      {error ? (
        <div className="p-2">
        <Problem
          tone="error"
          title="This agent's models could not be listed"
          reason={error}
          actions={
            <Button kind="secondary" size={28} onClick={onRetry}>
              Retry
            </Button>
          }
        />
        </div>
      ) : models?.length === 0 ? (
        <div className="space-y-3 p-4 text-[13px] leading-relaxed text-muted">
          {/* Empty is not always "nothing connected": a ChatGPT sign-in whose list could not be read lists none. */}
          <p>
            No model is available. Connect a provider with a subscription or an API key, or reconnect one that lists
            no models (a ChatGPT sign-in whose model list could not be read).
          </p>
          <Button kind="primary" size={28} onClick={onProviders}>
            Connect a provider
          </Button>
        </div>
      ) : (
        <>
          {ask && <AskNotice ask={ask} models={models} onProviders={onProviders} />}
          <div className="flex items-center gap-2 px-4 pt-3 pb-2">
            <MagnifyingGlass size={15} className="shrink-0 text-muted" aria-hidden />
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter models"
              placeholder="Search models"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
            {!models && (
              <p role="status" className="p-2.5 text-[13px] text-muted">
                Loading models…
              </p>
            )}
            {[...groups].map(([provider, members]) => (
              <section key={provider} aria-label={provider}>
                <h3 className="px-2.5 pt-2 pb-1 text-[12px] font-normal text-muted">{provider}</h3>
                {members.map(({ spec, name, contextWindow }) => (
                  <button
                    key={spec}
                    data-model={spec}
                    title={spec}
                    onClick={() => {
                      dialog.current?.close();
                      onClose();
                      void store.pickModel(spec);
                    }}
                    aria-current={spec === current ? "true" : undefined}
                    className={`flex w-full items-center gap-2 rounded-card px-2.5 py-2 text-left text-[13px] hover:bg-hover ${
                      spec === current ? "bg-hover" : ""
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{name ?? modelIdOf(spec)}</span>
                    {contextWindow !== undefined && <span className="shrink-0 text-[12px] text-muted tabular-nums">{tokens(contextWindow)}</span>}
                    {spec === current && <Check size={15} aria-hidden />}
                  </button>
                ))}
              </section>
            ))}
            {models && shown.length === 0 && <p className="px-2.5 py-2 text-[13px] text-muted">Nothing matches.</p>}
            {hidden > 0 && (
              <p className="px-2.5 py-2 text-[12px] text-muted">
                {hidden} more: search to narrow the list.
              </p>
            )}
          </div>
          <div className="border-t border-stroke">
            {!thinking ? (
              <p className="px-4 py-3 text-[12px] text-muted">Effort can be set once a model is chosen.</p>
            ) : !thinking.levels ? null : thinking.levels.length > 1 ? (
              <Effort levels={thinking.levels} level={thinking.level} onPick={(level) => void store.setThinking(level)} />
            ) : (
              <p className="px-4 py-3 text-[12px] text-muted">This model has no effort setting.</p>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}

/** Why the picker came up by itself, at its top: what is wrong in a line, and what to do. */
function AskNotice({ ask, models, onProviders }: { ask: ModelProblem; models?: Models; onProviders: () => void }) {
  if (ask.reason === "gone")
    return (
      <Notice
        title={`${ask.model} is no longer available`}
        advice="It is this agent's default. The model you choose here becomes the default, and this conversation's model."
      />
    );
  const notice = unavailableNotice(ask.model, models);
  if (!notice) return null;
  const { title, connect } = notice;
  return (
    <Notice title={title} advice={`Choose another model to send your message${connect ? ", or connect it" : ""}.`}>
      {connect && (
        <Button kind="secondary" size={28} icon={<Plug size={12} />} onClick={onProviders}>
          Connect {connect}
        </Button>
      )}
    </Notice>
  );
}

function Notice({ title, advice, children }: { title: string; advice: string; children?: ReactNode }) {
  return (
    <div role="status" className="mx-1.5 mt-1.5 flex gap-2.5 rounded-card bg-surface-2 px-3 py-2.5 text-[13px]">
      <Prohibit size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 space-y-1.5">
        <p className="leading-snug">
          <span className="font-semibold">{title}</span>
          <br />
          <span className="text-muted">{advice}</span>
        </p>
        {children}
      </div>
    </div>
  );
}

const ruler = document.createElement("canvas").getContext("2d")!;

export function Composer({
  view,
  store,
  onProviders,
}: {
  view: View;
  store: Store;
  onProviders: () => void;
}) {
  const { agentId, conversation: c, busy } = view;
  const agent = view.agents.find((row) => row.id === agentId);
  // What the conversation will run with: a chip naming a model the turn will not use is the failure to avoid.
  const model = c?.state?.model ?? view.model;
  const thinking = model
    ? { level: c?.state?.thinkingLevel, levels: view.models?.find((candidate) => candidate.spec === model)?.thinkingLevels }
    : undefined;
  const { needsModel, modelAsk, modelBlocked, picker: picking } = view;
  const value = c?.draft ?? "";
  const disabled = !!view.blocked;
  const empty = value.trim() === "";

  const input = useRef<HTMLTextAreaElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLDivElement>(null);
  // Decided from the draft and the room, never from the wrapping, so it cannot flip as the width changes.
  const [stacked, setStacked] = useState(false);
  const [fieldWidth, setFieldWidth] = useState(0);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setFieldWidth(entry!.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const text = input.current;
    const box = field.current;
    const side = chip.current;
    if (!text || !box || !side) return;
    const style = getComputedStyle(text);
    const padding = getComputedStyle(box);
    // 12px margin so a line that only just fits does not wrap.
    const room = box.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight) - side.offsetWidth - 8 - 12;
    ruler.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    setStacked(value.includes("\n") || ruler.measureText(value).width > room);
  }, [value, fieldWidth, model, thinking?.level]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    const style = getComputedStyle(el);
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    el.style.height = `${Math.min(el.scrollHeight, parseFloat(style.lineHeight) * 8 + padding)}px`;
  }, [value, stacked]);
  const [dismissed, setDismissed] = useState(false);
  const [cursor, setCursor] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  // Only arrow keys need to scroll the cursor's row into view; the pointer lands on visible rows.
  const stepped = useRef(false);
  useEffect(() => {
    if (stepped.current) list.current?.querySelector("[data-chosen]")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const stuck = modelAsk?.reason === "refused" && modelAsk.model === model;
  // Every opening rereads the credential file, so a provider connected in Settings shows up.
  useEffect(() => {
    if (picking) void store.loadModels();
  }, [picking, agentId, store]);

  const query = completionQuery(value);
  // Two floating lists over one composer read as a mistake.
  const suggestions = query === undefined || dismissed || picking ? [] : matches(view.commands, query);
  const chosen = suggestions[Math.min(cursor, suggestions.length - 1)];

  useEffect(() => {
    if (query !== undefined && agentId && !disabled) void store.loadCommands();
  }, [query, agentId, disabled, store]);
  // Keeping it dismissed until the line stops being a command would leave `/d` with no completion.
  useEffect(() => {
    setDismissed(false);
    setCursor(0);
    list.current?.scrollTo(0, 0);
  }, [query]);

  return (
    // Positioned so it paints above the absolutely placed veil, which would blur the buttons.
    <div className="composer relative">
      {view.commandsError && query !== undefined && (
        <p role="alert" className="text-danger text-[11px] mb-1.5 pl-4">
          {view.commandsError}
        </p>
      )}
      {/* `/` on an agent with no skills would otherwise do nothing, which reads as broken. */}
      {query !== undefined && !view.commandsError && view.commands.length === 0 && agent && (
        <p className="text-muted text-[11px] mb-1.5 pl-4">
          No commands — this agent has no skills in <span className="font-mono">{home(agent.dir)}/skills</span>
        </p>
      )}
      <div className="flex items-end gap-2">
        <div ref={field} className="composer-card relative flex min-w-0 flex-1 flex-wrap items-end gap-x-2 gap-y-1 rounded-composer bg-surface py-1.5 pr-1.5 pl-4 ring-1 ring-stroke focus-within:ring-accent/50">
          {suggestions.length > 0 && (
            <div ref={list} className="popover absolute bottom-full left-0 z-20 mb-2 max-h-72 w-[420px] max-w-full overflow-y-auto">
              {suggestions.map((command, index) => (
                <button
                  key={command.name}
                  // Moved, not entered: the list scrolling under a resting pointer reports a new row as entered.
                  onMouseMove={(event) => {
                    if (!event.movementX && !event.movementY) return;
                    stepped.current = false;
                    setCursor(index);
                  }}
                  onClick={() => store.setDraft(complete(command))}
                  data-chosen={command === chosen || undefined}
                  className={`flex w-full scroll-my-1.5 items-baseline gap-2.5 rounded-card px-2.5 py-2 text-left text-[13px] ${
                    command === chosen ? "bg-hover" : ""
                  }`}
                >
                  <span className="shrink-0">/{command.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{command.description}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={input}
            aria-label="Message"
            value={value}
            rows={1}
            onChange={(e) => store.setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (suggestions.length > 0 && !e.nativeEvent.isComposing) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const step = e.key === "ArrowDown" ? 1 : suggestions.length - 1;
                  stepped.current = true;
                  return setCursor((c) => (Math.min(c, suggestions.length - 1) + step) % suggestions.length);
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  return setDismissed(true);
                }
                // A bare `/name` is never a message.
                if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && chosen) {
                  e.preventDefault();
                  return store.setDraft(complete(chosen));
                }
              }
              // While an IME is composing, Enter picks a candidate — sending there would cut a word in half.
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              if (!disabled) void store.send();
            }}
            placeholder={view.blocked ?? (busy ? "steer the run…" : "Ask, build, / for commands…")}
            disabled={disabled}
            // Same leading as the bubble it becomes, so a long message does not reflow on send. 1px keeps one line 28 tall.
            className={`bubble min-h-7 min-w-0 resize-none bg-transparent py-px outline-none ${stacked ? "basis-full" : "flex-1"}  placeholder:text-muted disabled:opacity-40`}
          />
          <div ref={chip} className="relative ml-auto min-w-0 max-w-[45%]">
            <Button
              kind="ghost"
              size={28}
              onClick={picking ? store.closePicker : store.openPicker}
              disabled={modelBlocked && model ? `${modelBlocked} (${model})` : (modelBlocked ?? false)}
              title={model ? `Model for this agent: ${model}` : "Model for this agent"}
              className={`max-w-full bg-hover ${(!model && needsModel) || stuck ? "text-warning" : ""}`}
            >
              {model ? (
                // `openai/` and `azure-openai-responses/` offer the same ids and are paid for differently.
                <span className="min-w-0 truncate text-[13px]">
                  <span className="text-muted">{providerOf(model)}/</span>
                  <span className="text-text">{modelIdOf(model)}</span>
                </span>
              ) : (
                <span className="truncate">{needsModel ? "pick a model" : "reading model…"}</span>
              )}
              {thinking?.level !== undefined && (
                <span className="shrink-0 text-[13px] text-muted">{levelName(thinking.level)}</span>
              )}
              <CaretDown size={12} className="shrink-0" />
            </Button>
            {picking && !modelBlocked && (
              <ModelPicker
                view={view}
                store={store}
                current={model}
                thinking={thinking}
                ask={modelAsk?.reason === "needs" ? undefined : modelAsk}
                onClose={store.closePicker}
                onProviders={() => {
                  store.closePicker();
                  onProviders();
                }}
              />
            )}
          </div>
        </div>
        {busy && empty ? (
          <Button
            kind="danger"
            loud
            size={40}
            onClick={() => void store.abort()}
            aria-label="Stop the run"
            title="Stop (Esc) — work its tools already finished is not undone"
            icon={<Stop size={16} weight="fill" />}
          />
        ) : (
          <Button
            kind="primary"
            size={40}
            onClick={() => void store.send()}
            disabled={view.blocked ?? (empty && "Nothing to send yet")}
            aria-label={busy ? "Steer the run" : "Send"}
            title={busy ? "Steer the run (⏎): it joins after the current step · Stop with Esc" : "Send (⏎) · newline (⇧⏎)"}
            icon={<ArrowUp size={18} />}
          />
        )}
      </div>
    </div>
  );
}
