import { Fragment, useEffect, useState } from "react";
import { ArrowSquareOut, FolderSimple, ListBullets, Plus, SidebarSimple, WarningCircle, X } from "@phosphor-icons/react";
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
  details?: { open: boolean; onToggle: () => void };
  list?: { open: boolean; unseen: number };
  onReveal: () => void;
  onRevealPath?: (path: string) => void;
  onUsagePage: (provider: string) => void;
}) {
  return (
    // Floats over the scroll area, aligned to the reading column; only interactive parts take the pointer.
    <header className="pointer-events-none absolute inset-x-0 top-2 z-10 px-6">
      <div className="column">
        <div className="conversation-header flex min-w-0 items-center gap-2.5 rounded-composer bg-surface/85 py-1.5 pr-1.5 pl-2 ring-1 ring-stroke backdrop-blur-xl">
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
                  {details && !details.open && (
                    <>
                      <span className="shrink-0">·</span>
                      <button
                        type="button"
                        onClick={details.onToggle}
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
          {(list || details) && (
            <div className="pointer-events-auto flex shrink-0 items-center gap-0.5 border-l border-stroke pl-1.5">
              {list && (
                <Button
                  kind="ghost"
                  size={32}
                  popoverTarget="conversations"
                  aria-label={list.unseen ? `Conversations, ${list.unseen} unseen` : "Conversations"}
                  title="Conversations"
                  icon={
                    <span className="relative">
                      <ListBullets size={17} />
                      {list.unseen > 0 && <span className="absolute -top-0.5 -right-1 size-2 rounded-full bg-accent" />}
                    </span>
                  }
                  className={`conversations-anchor ${list.open ? "bg-hover text-text" : ""}`}
                />
              )}
              {details && (
                <Button
                  kind="ghost"
                  size={32}
                  onClick={details.onToggle}
                  aria-label="Agent details"
                  aria-pressed={details.open}
                  title={details.open ? "Hide agent details" : "Agent details"}
                  icon={<SidebarSimple size={17} className="-scale-x-100" />}
                  className={details.open ? "bg-accent-weak text-accent" : ""}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

const rowDivider =
  "relative [&+&]:before:content-[''] [&+&]:before:absolute [&+&]:before:top-0 [&+&]:before:right-0 [&+&]:before:left-3 [&+&]:before:h-px [&+&]:before:bg-stroke";

export function AgentInspector({
  id,
  name,
  colour,
  face,
  dir,
  content = [],
  commands = [],
  tools = [],
  busy,
  onClose,
  onPickFolder,
  onAddFolder,
  onRemoveFolder,
  onReveal,
  onRevealPath,
}: {
  id: string;
  name: string;
  colour: number;
  face: Face;
  dir: string;
  content?: AgentContent[];
  commands?: AgentCapability[];
  tools?: AgentCapability[];
  busy: boolean;
  onClose: () => void;
  onPickFolder: () => Promise<{ name: string; path: string } | undefined>;
  onAddFolder: (folder: string) => Promise<string | undefined>;
  onRemoveFolder: (name: string) => Promise<string | undefined>;
  onReveal: () => void;
  onRevealPath: (path: string) => void;
}) {
  const [error, setError] = useState<string>();
  const [updating, setUpdating] = useState(false);
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

  const removeFolder = async (folderName: string) => {
    if (disabledReason) return;
    setError(undefined);
    setUpdating(true);
    try {
      const refusal = await onRemoveFolder(folderName);
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
    <aside
      id="agent-info"
      aria-label="Agent details"
      className="w-[clamp(16.5rem,24vw,19.5rem)] shrink-0 flex flex-col min-h-0 rounded-float bg-sidebar ring-1 ring-stroke overflow-hidden"
    >
      <div className="h-12 shrink-0 flex items-center gap-2.5 border-b border-stroke px-3 drag">
        <Avatar id={id} name={name} colour={colour} size={24} face={face} />
        <span className="min-w-0 flex-1 truncate font-prose text-[15px] font-semibold text-text" title={name}>
          {name}
        </span>
        <Button
          kind="ghost"
          size={28}
          onClick={onClose}
          aria-label="Close agent details"
          title="Close"
          icon={<X size={15} />}
          className="no-drag"
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
        <section className="space-y-1.5">
          <div className="flex items-baseline justify-between px-1">
            <h3 className="text-[12px] font-semibold text-text">Folders it works on</h3>
            <span className="text-[11px] text-muted tabular-nums">{content.length}</span>
          </div>
          {error && explained && (
            <div role="alert" className="rounded-card bg-surface p-2.5 ring-1 ring-stroke">
              <div className="flex gap-2 text-[12px]">
                <WarningCircle size={14} className="mt-0.5 shrink-0 text-danger" />
                <div className="min-w-0 space-y-0.5 break-words">
                  <p className="font-medium text-text">{explained.title}</p>
                  {explained.advice && <p className="text-muted">{explained.advice}</p>}
                  <p className="font-mono text-[11px] text-muted">{error}</p>
                </div>
              </div>
            </div>
          )}
          <div className="rounded-card bg-surface ring-1 ring-stroke overflow-hidden">
            {content.map((entry) => (
              <div key={entry.name} className={`${rowDivider} flex items-center gap-1 pr-1.5`}>
                <button
                  type="button"
                  onClick={() => onRevealPath(entry.location)}
                  title={entry.location}
                  className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 pr-1 text-left transition-colors hover:text-text"
                >
                  <FolderSimple size={15} className="shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-text">{entry.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted">{home(entry.location)}</div>
                  </div>
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
              className={`${rowDivider} flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] font-medium text-accent transition-colors hover:bg-hover disabled:opacity-50`}
            >
              <Plus size={15} weight="bold" />
              <span>Add folder…</span>
            </button>
          </div>
          <p className="px-1 text-[11px] leading-relaxed text-muted">
            Removing a folder here only detaches it; your files stay on disk.
          </p>
        </section>

        <section className="space-y-1.5">
          <div className="px-1">
            <h3 className="text-[12px] font-semibold text-text">Agent folder</h3>
          </div>
          <button
            type="button"
            onClick={onReveal}
            title={dir}
            className="flex w-full items-center justify-between gap-2.5 rounded-card bg-surface px-3 py-2.5 text-left ring-1 ring-stroke transition-colors hover:bg-hover"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[12px] text-text">{home(dir)}</div>
              <div className="mt-0.5 text-[11px] text-muted">Show agent folder in Finder</div>
            </div>
            <ArrowSquareOut size={14} className="shrink-0 text-muted" />
          </button>
        </section>

        <section className="space-y-1.5">
          <div className="flex items-baseline justify-between px-1">
            <h3 className="text-[12px] font-semibold text-text">Tools</h3>
            <span className="text-[11px] text-muted tabular-nums">{tools.length}</span>
          </div>
          <div className="rounded-card bg-surface p-2.5 ring-1 ring-stroke">
            {tools.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {tools.map((tool) => (
                  <span
                    key={tool.name}
                    title={tool.description}
                    className="rounded-[4px] bg-raised px-2 py-0.5 font-mono text-[11px] text-muted"
                  >
                    {tool.name}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-[12px] text-muted">None loaded</span>
            )}
          </div>
        </section>

        <section className="space-y-1.5">
          <div className="flex items-baseline justify-between px-1">
            <h3 className="text-[12px] font-semibold text-text">Skills</h3>
            <span className="text-[11px] text-muted tabular-nums">{skills.length}</span>
          </div>
          {skills.length > 0 ? (
            <div className="rounded-card bg-surface ring-1 ring-stroke overflow-hidden">
              {skills.map((skill) => (
                <div key={skill.name} className={`${rowDivider} px-3 py-2`}>
                  <div className="font-mono text-[12.5px] font-medium text-text">
                    {skill.name.slice("skill:".length)}
                  </div>
                  {skill.description && (
                    <div className="mt-0.5 text-[12px] leading-snug text-muted line-clamp-2">
                      {skill.description}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-card bg-surface px-3 py-2.5 text-[12px] text-muted ring-1 ring-stroke">
              No skills in <span className="font-mono text-[11px]">skills/</span> yet.
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
