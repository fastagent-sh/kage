import { useEffect, useRef, useState } from "react";
import { GearSix, Plus, WarningCircle, X } from "@phosphor-icons/react";
import type { AgentRow, KageApi } from "../preload/index.ts";
import { stamp } from "./time.ts";
import type { Row } from "./sessions.ts";
import { Avatar } from "./avatar.tsx";
import { faceOf } from "./face.ts";
import { Badge, Button, Pill, type Tone } from "./ui.tsx";
import type { AgentState, Preview } from "./store.ts";
import type { Activity } from "./transcript.ts";
import { ResponsivePanel } from "./responsive-panel.tsx";

const tones: Record<AgentState, Tone> = {
  ready: "accent",
  missing_dir: "danger",
  broken: "danger",
};

const says: Record<AgentState, string> = {
  ready: "Ready",
  missing_dir: "Folder not found",
  broken: "Broken",
};

function RenameField({
  label,
  value: initial,
  className,
  onCommit,
  onCancel,
}: {
  label: string;
  value: string;
  className: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      aria-label={label}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(event) => {
        // The list's arrows and Delete belong to rows, not to a text field.
        event.stopPropagation();
        if (event.key === "Enter") onCommit(value);
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      className={`rounded-card bg-bg px-2 py-1 outline-none ring-1 ring-accent/60 ${className}`}
    />
  );
}

function useRestoreFocus(find: (key: string) => HTMLElement | null | undefined) {
  const restore = useRef<string>(undefined);
  useEffect(() => {
    const key = restore.current;
    const el = key ? find(key) : undefined;
    if (!el) return;
    restore.current = undefined;
    el.focus();
  });
  return restore;
}

// Conversations live in the header's list: listed here they turned contacts into folders.
export function Sidebar({
  overlay,
  open,
  onClose,
  agents,
  agentId,
  states,
  running,
  doing,
  unseen,
  previews,
  latest,
  errors,
  settingsOpen,
  creatingOpen,
  onSelect,
  onAdd,
  onSettings,
  onRename,
  onReveal,
  onMenu,
}: {
  overlay: boolean;
  open: boolean;
  onClose: () => void;
  agents: AgentRow[];
  agentId?: string;
  states: Record<string, AgentState>;
  running: Record<string, string[]>;
  doing: Record<string, Activity>;
  unseen: Record<string, Record<string, "done" | "failed">>;
  previews: Record<string, Preview>;
  latest: (agentId: string) => Row | undefined;
  errors: Record<string, string>;
  settingsOpen: boolean;
  creatingOpen?: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onSettings: () => void;
  onRename: (id: string, name: string) => void;
  onReveal: (id: string) => void;
  onMenu: KageApi["menu"];
}) {
  // One tab stop for the roster (§11, WAI-ARIA APG): Tab reaches it, arrows move inside it.
  const [reached, setReached] = useState<string>();
  const active = (agents.find((row) => row.id === reached) ?? agents.find((row) => row.id === agentId) ?? agents[0])?.id;
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [renaming, setRenaming] = useState<string>();
  const restore = useRestoreFocus((id) => buttons.current.get(id));
  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = agents.findIndex((row) => row.id === active);
    const to = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: agents.length - 1 }[event.key];
    const target = to === undefined ? undefined : agents[Math.max(0, Math.min(agents.length - 1, to))];
    if (!target) return;
    event.preventDefault();
    setReached(target.id);
    buttons.current.get(target.id)?.focus();
  };
  const endRename = (id: string) => {
    // The row's button is unmounted while the field stands in for it, so focus is taken back once
    // it exists again.
    restore.current = id;
    setRenaming(undefined);
  };
  return (
    <ResponsivePanel
      id="agent-roster"
      overlay={overlay}
      open={open}
      onClose={onClose}
      aria-label="Agents"
      className="sidebar-panel w-[clamp(13.5rem,20vw,16.5rem)] shrink-0 flex flex-col min-h-0 rounded-float bg-sidebar ring-1 ring-stroke overflow-hidden"
    >
      {/* The wordmark is centred in the column, not pushed along by the window controls overhanging it. */}
      <div className="relative h-12 shrink-0 flex items-center px-2 drag">
        <span className="sidebar-wordmark absolute left-1/2 -translate-x-1/2 font-medium tracking-[-0.01em]">
          kage<span className="text-accent">·</span>
        </span>
        <span className="flex-1" />
        <Button
          kind="ghost"
          size={28}
          onClick={onAdd}
          className="no-drag sidebar-add"
          title="Create agent"
          aria-label="Create agent"
          icon={<Plus size={16} />}
        />
        {overlay && (
          <Button
            kind="ghost"
            size={28}
            onClick={onClose}
            className="no-drag"
            aria-label="Close agents"
            title="Close"
            icon={<X size={15} />}
          />
        )}
      </div>

      {/* The 4px padding is the focus ring's reach: the list clips, and the first ring would lose its top edge. */}
      <div role="navigation" aria-label="Agents" className="flex-1 overflow-y-auto min-h-0 px-1.5 py-1" onKeyDown={onKeyDown}>
        {agents.map((agent) => {
          const selected = agent.id === agentId;
          const state = states[agent.id] ?? "ready";
          const busy = running[agent.id]?.length ?? 0;
          const waiting = Object.values(unseen[agent.id] ?? {});
          const failures = waiting.filter((outcome) => outcome === "failed").length;
          const preview = previews[agent.id];
          const last = latest(agent.id);
          const at = preview ? preview.at : last?.updatedAt;
          const error = errors[agent.id] ?? preview?.error;
          const filled = selected && !settingsOpen && !creatingOpen;
          const status = `status-${agent.id}`;
          const rename = () => setRenaming(agent.id);
          // The same face while it is being renamed: the work it is doing has not stopped.
          const face = faceOf({ state, doing: busy > 0 ? doing[agent.id] : undefined, outcomes: waiting, open: filled });
          return (
            // A hairline running into a rounded fill reads as a cut.
            <div key={agent.id} className="roster-row" data-filled={filled || undefined}>
              {renaming === agent.id ? (
                <div className="flex items-center gap-2.5 px-2 py-2">
                  <Avatar id={agent.id} name={agent.name} colour={agent.colour} size={40} face={face} />
                  <RenameField
                    label="Agent name"
                    value={agent.name}
                    className="min-w-0 flex-1 font-prose text-[13px]"
                    onCancel={() => endRename(agent.id)}
                    onCommit={(name) => {
                      endRename(agent.id);
                      if (name.trim() && name.trim() !== agent.name) onRename(agent.id, name.trim());
                    }}
                  />
                </div>
              ) : (
                <button
                  ref={(el) => {
                    if (el) buttons.current.set(agent.id, el);
                    else buttons.current.delete(agent.id);
                  }}
                  tabIndex={active === agent.id ? 0 : -1}
                  aria-label={agent.name}
                  aria-describedby={status}
                  aria-current={filled ? "true" : undefined}
                  onFocus={() => setReached(agent.id)}
                  onClick={() => onSelect(agent.id)}
                  onDoubleClick={rename}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void onMenu([
                      { id: "rename", label: "Rename…" },
                      { id: "reveal", label: "Reveal in Finder" },
                    ]).then((chosen) => {
                      if (chosen === "rename") rename();
                      if (chosen === "reveal") onReveal(agent.id);
                    });
                  }}
                  title={`${agent.name}\n${agent.dir}\n${busy ? "Working" : says[state]}`}
                  className={`flex w-full items-center gap-2.5 rounded-card px-2 py-2 text-left transition-colors ${
                    filled ? "bg-accent-weak text-text" : "hover:bg-hover"
                  }`}
                >
                  <Avatar
                    id={agent.id}
                    name={agent.name}
                    colour={agent.colour}
                    size={40}
                    face={face}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate font-prose text-[15px] leading-5 font-semibold">{agent.name}</span>
                      {/* Busy goes where the time goes: the preview below is the work itself, streaming. */}
                      {busy > 0 ? (
                        <Badge tone="accent" pulse className="shrink-0">
                          {busy > 1 ? `${busy} working` : "working"}
                        </Badge>
                      ) : (
                        at !== undefined && <span className="shrink-0 text-[11px] text-muted tabular-nums">{stamp(at)}</span>
                      )}
                    </span>
                    <span id={status} className="mt-0.5 flex h-[34px] items-start gap-2 text-[13px] leading-[17px]">
                      {/* Said in words, never a coloured dot alone (§9). */}
                      {state !== "ready" ? (
                        <Badge tone={tones[state]} className="min-w-0 flex-1">
                          <span className="truncate">{says[state].toLowerCase()}</span>
                        </Badge>
                      ) : error ? (
                        <Badge tone="danger" icon={<WarningCircle size={12} />} className="min-w-0 flex-1" title={error}>
                          <span className="truncate">conversations could not be read</span>
                        </Badge>
                      ) : (
                        <span className="min-w-0 flex-1 line-clamp-2 break-words font-prose text-muted">
                          {preview?.text ?? (preview ? "New conversation" : last?.label ?? "No conversations yet")}
                        </span>
                      )}
                      {/* On the quote's first line, so the right column is the same for one-line and two-line quotes. */}
                      {waiting.length > 0 && (
                        <span
                          className="pop shrink-0 self-start"
                          title={`${waiting.length - failures} finished, ${failures} failed while you were away`}
                        >
                          <Pill tone={failures ? "danger" : "accent"}>{waiting.length}</Pill>
                          <span className="sr-only">
                            {failures ? `${failures} failed` : "done"} while you were away
                          </span>
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="shrink-0 border-t border-stroke px-1.5 py-1.5">
        <button
          onClick={onSettings}
          aria-current={settingsOpen ? "page" : undefined}
          title="Settings (⌘,)"
          className={`flex w-full items-center gap-2.5 rounded-card h-8 px-3 text-left text-[13px] transition-colors ${
            settingsOpen ? "bg-accent-weak text-accent" : "text-muted hover:bg-hover hover:text-text"
          }`}
        >
          <GearSix size={16} aria-hidden />
          Settings
        </button>
      </div>
    </ResponsivePanel>
  );
}

// A native popover: top layer, light dismiss and Escape are the platform's.
export function ConversationList({
  rows,
  session,
  error,
  disabled,
  onToggle,
  onOpen,
  onNew,
}: {
  rows: Row[];
  session?: string;
  error?: string;
  disabled: boolean;
  onToggle: (open: boolean) => void;
  onOpen: (session: string) => void;
  onNew: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // An open popover that unmounts fires no toggle event, so whoever mirrors its state is told here.
  useEffect(() => () => onToggle(false), [onToggle]);
  const close = () => panel.current?.hidePopover();
  const onKeyDown = (event: React.KeyboardEvent) => {
    const all = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-session]")];
    const index = all.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    all[index + step]?.focus();
  };
  return (
    <div
      ref={panel}
      id="conversations"
      popover="auto"
      aria-label="Conversations"
      onToggle={(event) => onToggle(event.newState === "open")}
      className="popover w-80"
    >
      <div className="flex h-8 items-center justify-between pr-0.5 pl-2.5">
        <span className="text-[12px] font-medium text-muted">Conversations</span>
        <Button
          kind="ghost"
          size={28}
          onClick={() => {
            close();
            onNew();
          }}
          disabled={disabled && "The agent is still opening"}
          title="New conversation (⌘N)"
          aria-label="New conversation"
          icon={<Plus size={16} />}
        />
      </div>
      {error && (
        <div role="alert" className="flex gap-2 px-2.5 pb-1.5 text-[12px]">
          <WarningCircle size={13} className="mt-0.5 shrink-0 text-danger" />
          <p className="min-w-0 break-words">
            <span className="text-text">The list could not be read.</span>{" "}
            <span className="font-mono text-[12.5px] text-muted">{error}</span>
          </p>
        </div>
      )}
      <div className="max-h-[min(28rem,65vh)] overflow-y-auto" onKeyDown={onKeyDown}>
        {rows.map((row) => {
          const current = row.session === session;
          return (
            <div key={row.session} className="group relative">
              <button
                data-session={row.session}
                onClick={() => {
                  close();
                  onOpen(row.session);
                }}
                disabled={disabled}
                aria-current={current ? "page" : undefined}
                className={`flex w-full items-baseline gap-2 rounded-card py-1.5 pr-3 pl-2.5 text-left transition-colors ${
                  current ? "bg-accent-weak text-accent" : "hover:bg-hover"
                }`}
              >
                <span
                  className={`min-w-0 flex-1 truncate font-prose text-[13px] ${row.fresh ? `${current ? "" : "text-muted"} italic` : ""} ${
                    row.unseen ? "font-semibold" : ""
                  }`}
                >
                  {row.label}
                </span>
                {row.running ? (
                  <Badge tone="accent" pulse>
                    working
                  </Badge>
                ) : row.unseen ? (
                  <Pill tone={row.unseen === "failed" ? "danger" : "accent"}>{row.unseen}</Pill>
                ) : row.draft ? (
                  <span className="shrink-0 text-[11px] italic text-muted">unsent</span>
                ) : (
                  row.updatedAt !== undefined && (
                    <span className="shrink-0 text-[11px] text-muted tabular-nums">
                      {stamp(row.updatedAt)}
                    </span>
                  )
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
