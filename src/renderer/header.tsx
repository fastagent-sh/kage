import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, FolderSimple, ListBullets, Plus, WarningCircle, X } from "@phosphor-icons/react";
import type { AgentCapability, AgentContent, ProviderUsage } from "../preload/index.ts";
import { explainContentError } from "./panels.tsx";
import { home, location } from "./paths.ts";
import { UsageMeter } from "./plan-usage.tsx";
import { Avatar } from "./avatar.tsx";
import type { Face } from "./face.ts";
import { Badge, Button } from "./ui.tsx";

export function ConversationHeader({
  id,
  agent,
  colour,
  face,
  dir,
  content,
  working,
  others,
  context,
  plan,
  queued,
  details,
  list,
  onReveal,
  onRevealPath,
  onUsagePage,
}: {
  id: string;
  agent: string;
  colour: number;
  face: Face;
  dir?: string;
  content?: AgentContent[];
  working: boolean;
  others?: { count: number; open?: () => void };
  context?: { used: number; window: number };
  plan?: { data?: ProviderUsage; error?: string };
  queued?: number;
  details?: { open: boolean };
  list?: { open: boolean; unseen: number };
  onReveal: () => void;
  onRevealPath?: (path: string) => void;
  onUsagePage: (provider: string) => void;
}) {
  return (
    // Floats over the scroll area, so it lets the wheel through; only interactive parts take the pointer.
    <header className="pointer-events-none absolute inset-x-4 top-2 z-10">
      <div className="flex items-stretch gap-2">
        <div className="conversation-header flex min-w-0 flex-1 items-center gap-2.5 rounded-composer bg-surface/75 py-1.5 pr-2 pl-2 ring-1 ring-stroke backdrop-blur-xl">
          <Avatar id={id} name={agent} colour={colour} size={30} face={face} />
          <div className="min-w-0 flex-1">
            {/* The name doubles as the window's drag handle, which the frameless title bar needs. */}
            <div className="pointer-events-auto min-w-0 drag">
              <div className="truncate font-prose font-semibold" title={agent}>
                {agent}
              </div>
            </div>
            {content && content.length > 0 ? (
              <div className="pointer-events-auto flex max-w-full items-center gap-1 truncate text-[11px] text-muted">
                <span className="shrink-0">works on</span>
                {content.map((entry, index) => (
                  <Fragment key={entry.name}>
                    {index > 0 && <span className="shrink-0">·</span>}
                    <button
                      type="button"
                      onClick={() => (onRevealPath ? onRevealPath(entry.location) : onReveal())}
                      title={entry.location}
                      className="truncate text-left hover:text-text"
                    >
                      {entry.name}
                    </button>
                  </Fragment>
                ))}
              </div>
            ) : (
              dir && (
                <div className="pointer-events-auto flex max-w-full items-center gap-1 truncate text-[11px] text-muted">
                  <button
                    type="button"
                    onClick={onReveal}
                    title={dir}
                    className="truncate text-left hover:text-text"
                  >
                    {location(dir)}
                  </button>
                  {details && (
                    <>
                      <span className="shrink-0">·</span>
                      <button
                        type="button"
                        popoverTarget="agent-info"
                        className="shrink-0 hover:text-text"
                      >
                        Add folder…
                      </button>
                    </>
                  )}
                </div>
              )
            )}
          </div>
          {working ? (
            <Badge tone="accent" pulse>
              working
            </Badge>
          ) : (
            others && (
              <button
                onClick={others.open}
                popoverTarget={others.open ? undefined : "conversations"}
                title={others.open ? "Open the conversation that is working" : "Show the conversations that are working"}
                className="pointer-events-auto shrink-0 rounded-full px-1.5 py-0.5 hover:bg-hover"
              >
                <Badge tone="accent" pulse>
                  {others.count} other working
                </Badge>
              </button>
            )
          )}
          <UsageMeter plan={plan} context={context} onPage={onUsagePage} />
          {!!queued && <span className="shrink-0 text-[11px] text-muted">{queued} queued</span>}
          {details && (
            <Button
              kind="ghost"
              size={28}
              popoverTarget="agent-info"
              aria-label="Agent details"
              title="Agent details and folders"
              icon={<FolderSimple size={15} />}
              className={`agent-info-anchor pointer-events-auto shrink-0 ${details.open ? "bg-hover text-text" : ""}`}
            />
          )}
        </div>
        {list && (
          <div className="conversation-header grid aspect-square shrink-0 place-items-center rounded-full bg-surface/75 ring-1 ring-stroke backdrop-blur-xl">
            <Button
              kind="ghost"
              size={40}
              popoverTarget="conversations"
              aria-label={list.unseen ? `Conversations, ${list.unseen} unseen` : "Conversations"}
              title="Conversations"
              icon={
                <span className="relative">
                  <ListBullets size={18} />
                  {list.unseen > 0 && <span className="absolute -top-0.5 -right-1 size-2 rounded-full bg-accent" />}
                </span>
              }
              className={`conversations-anchor pointer-events-auto ${list.open ? "bg-hover" : ""}`}
            />
          </div>
        )}
      </div>
    </header>
  );
}

export function AgentDetails({
  dir,
  content = [],
  commands = [],
  tools = [],
  busy,
  onToggle,
  onPickFolder,
  onAddFolder,
  onRemoveFolder,
  onReveal,
  onRevealPath,
}: {
  dir: string;
  content?: AgentContent[];
  commands?: AgentCapability[];
  tools?: AgentCapability[];
  busy: boolean;
  onToggle: (open: boolean) => void;
  onPickFolder: () => Promise<{ name: string; path: string } | undefined>;
  onAddFolder: (folder: string) => Promise<string | undefined>;
  onRemoveFolder: (name: string) => Promise<string | undefined>;
  onReveal: () => void;
  onRevealPath: (path: string) => void;
}) {
  const [error, setError] = useState<string>();
  const [updating, setUpdating] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => () => onToggle(false), [onToggle]);
  useEffect(() => {
    setError(undefined);
  }, [dir]);

  const disabledReason =
    (busy && "Stop the running conversation before changing folders") ||
    (updating && "Updating folders…") ||
    false;

  const addFolder = async () => {
    if (disabledReason) return;
    setError(undefined);
    try {
      const picked = await onPickFolder();
      if (!picked) return;
      setUpdating(true);
      try {
        const refusal = await onAddFolder(picked.path);
        if (refusal) setError(refusal);
      } finally {
        setUpdating(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeFolder = async (name: string) => {
    if (disabledReason) return;
    setError(undefined);
    setUpdating(true);
    try {
      const refusal = await onRemoveFolder(name);
      if (refusal) setError(refusal);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdating(false);
    }
  };

  const explained = error ? explainContentError(error, "The folders could not be updated") : undefined;
  const skills = commands.filter((cmd) => cmd.name.startsWith("skill:"));

  return (
    <div
      ref={panel}
      id="agent-info"
      popover="auto"
      aria-label="Agent details"
      onToggle={(event) => onToggle(event.newState === "open")}
      className="popover w-80"
    >
      <div className="flex h-7 items-center px-2.5">
        <span className="text-[11px] font-medium text-muted">Folders it works on</span>
      </div>
      {error && explained && (
        <div role="alert" className="flex gap-2 px-2.5 pb-1.5 text-[12px]">
          <WarningCircle size={13} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0 space-y-0.5 break-words">
            <p className="font-medium text-text">{explained.title}</p>
            {explained.advice && <p className="text-muted">{explained.advice}</p>}
            <p className="font-mono text-[11px] text-muted">{error}</p>
          </div>
        </div>
      )}
      <div className="max-h-52 overflow-y-auto">
        {content.map((entry) => (
          <div key={entry.name} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onRevealPath(entry.location)}
              title={entry.location}
              className="min-w-0 flex-1 rounded-card px-2.5 py-1.5 text-left transition-colors hover:bg-hover"
            >
              <div className="truncate text-[13px] font-medium text-text">{entry.name}</div>
              <div className="truncate font-mono text-[11px] text-muted">{home(entry.location)}</div>
            </button>
            <Button
              kind="ghost"
              size={28}
              onClick={() => void removeFolder(entry.name)}
              disabled={disabledReason}
              title={`Remove ${entry.name}`}
              aria-label={`Remove ${entry.name}`}
              icon={<X size={13} />}
            />
          </div>
        ))}
        <button
          type="button"
          onClick={() => void addFolder()}
          disabled={!!disabledReason}
          title={disabledReason || undefined}
          className="flex w-full items-center gap-2 rounded-card px-2.5 py-1.5 text-left text-[13px] text-accent transition-colors hover:bg-hover disabled:opacity-50"
        >
          <Plus size={14} weight="bold" />
          <span>Add folder…</span>
        </button>
      </div>
      <div className="mt-1.5 border-t border-stroke pt-1.5">
        <div className="px-2.5 pb-0.5 text-[11px] font-medium text-muted">Agent folder</div>
        <button
          type="button"
          onClick={onReveal}
          title={dir}
          className="flex w-full items-center justify-between gap-2 rounded-card px-2.5 py-1.5 text-left transition-colors hover:bg-hover"
        >
          <span className="truncate font-mono text-[12px] text-muted">{home(dir)}</span>
          <ArrowSquareOut size={13} className="shrink-0 text-muted" />
        </button>
      </div>
      <div className="mt-1.5 border-t border-stroke pt-1.5">
        {skills.length > 0 && (
          <div className="mb-2.5">
            <div className="px-2.5 pb-1 text-[11px] font-medium text-muted">Skills</div>
            <div className="flex flex-wrap gap-1 px-2.5">
              {skills.map((skill) => (
                <span
                  key={skill.name}
                  title={skill.description}
                  className="rounded-[4px] bg-raised px-1.5 py-0.5 font-mono text-[11px] text-text"
                >
                  {skill.name.slice("skill:".length)}
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="px-2.5 pb-1 text-[11px] font-medium text-muted">Tools</div>
        <div className="flex flex-wrap gap-1 px-2.5 pb-1.5">
          {tools.length > 0 ? (
            tools.map((tool) => (
              <span
                key={tool.name}
                title={tool.description}
                className="rounded-[4px] bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted"
              >
                {tool.name}
              </span>
            ))
          ) : (
            <span className="text-[12px] text-muted">None loaded</span>
          )}
        </div>
      </div>
    </div>
  );
}
