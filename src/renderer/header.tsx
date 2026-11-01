import { Fragment, useEffect, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  Check,
  Cpu,
  FileText,
  FolderSimple,
  Key,
  ListBullets,
  Plus,
  SidebarSimple,
  Sparkle,
  Trash,
  WarningCircle,
  Wrench,
  X,
} from "@phosphor-icons/react";
import type { AgentCapability, AgentContent, AgentInspection, ProviderUsage } from "../preload/index.ts";
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

const SKILL_PREVIEW_LIMIT = 3;

export function AgentInspector({
  id,
  name,
  colour,
  face,
  dir,
  model,
  showModel,
  skillBlocked,
  content = [],
  commands = [],
  tools = [],
  inspection,
  busy,
  loading,
  onClose,
  onPickFolder,
  onAddFolder,
  onRemoveFolder,
  onSetSecret,
  onRemoveSecret,
  onReveal,
  onRevealPath,
  onSelectSkill,
  onRemove,
}: {
  id: string;
  name: string;
  colour: number;
  face: Face;
  dir: string;
  model?: string;
  showModel?: boolean;
  skillBlocked?: string;
  content?: AgentContent[];
  commands?: AgentCapability[];
  tools?: AgentCapability[];
  inspection?: AgentInspection;
  busy: boolean;
  loading?: boolean;
  onClose: () => void;
  onPickFolder: () => Promise<{ name: string; path: string } | undefined>;
  onAddFolder: (folder: string) => Promise<string | undefined>;
  onRemoveFolder: (name: string) => Promise<string | undefined>;
  onSetSecret?: (name: string, value: string) => Promise<string | undefined>;
  onRemoveSecret?: (name: string) => Promise<string | undefined>;
  onReveal: () => void;
  onRevealPath: (path: string) => void;
  onSelectSkill?: (skillName: string) => void;
  onRemove?: () => void;
}) {
  const [error, setError] = useState<string>();
  const [updating, setUpdating] = useState(false);
  const [showAllSkills, setShowAllSkills] = useState(false);
  const [editingSecret, setEditingSecret] = useState<{ name: string; value: string; fixedName?: boolean }>();
  const [secretError, setSecretError] = useState<string>();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setError(undefined);
    setSecretError(undefined);
    setEditingSecret(undefined);
    setShowAllSkills(false);
  }, [dir]);

  const disabledReason =
    (busy && "Stop the running conversation before changing agent settings") ||
    (updating && "Updating agent…") ||
    (loading && "Opening the agent…") ||
    false;

  const addFolder = async () => {
    if (disabledReason) return;
    setError(undefined);
    try {
      const picked = await onPickFolder();
      if (!picked || !mounted.current) return;
      setUpdating(true);
      try {
        const refusal = await onAddFolder(picked.path);
        if (mounted.current && refusal) setError(refusal);
      } finally {
        if (mounted.current) setUpdating(false);
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeFolder = async (folderName: string) => {
    if (disabledReason) return;
    setError(undefined);
    setUpdating(true);
    try {
      const refusal = await onRemoveFolder(folderName);
      if (mounted.current && refusal) setError(refusal);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setUpdating(false);
    }
  };

  const saveSecret = async () => {
    if (!editingSecret || !onSetSecret || disabledReason) return;
    setSecretError(undefined);
    setUpdating(true);
    try {
      const refusal = await onSetSecret(editingSecret.name, editingSecret.value);
      if (!mounted.current) return;
      if (refusal) setSecretError(refusal);
      else setEditingSecret(undefined);
    } catch (err) {
      if (mounted.current) setSecretError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setUpdating(false);
    }
  };

  const deleteSecret = async (secretName: string) => {
    if (!onRemoveSecret || disabledReason) return;
    setSecretError(undefined);
    setUpdating(true);
    try {
      const refusal = await onRemoveSecret(secretName);
      if (mounted.current && refusal) setSecretError(refusal);
    } catch (err) {
      if (mounted.current) setSecretError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setUpdating(false);
    }
  };

  const explained = error ? explainContentError(error, "The folders could not be updated") : undefined;
  const skills = commands.filter((cmd) => cmd.name.startsWith("skill:"));
  const visibleSkills = showAllSkills ? skills : skills.slice(0, SKILL_PREVIEW_LIMIT);
  const files = inspection?.files ?? [];
  const secrets = inspection?.secrets ?? [];
  const packages = inspection?.packages ?? [];

  return (
    <aside
      id="agent-info"
      aria-label="Agent details"
      className="w-[clamp(19rem,28vw,23rem)] shrink-0 flex flex-col min-h-0 rounded-float bg-sidebar ring-1 ring-stroke overflow-hidden"
    >
      <div className="h-10 shrink-0 flex items-center justify-end px-2.5 pt-1 drag">
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

      <div className="flex-1 min-h-0 overflow-y-auto px-3.5 pb-4 space-y-4">
        <div className="flex flex-col items-center px-2 pb-1 text-center">
          <Avatar id={id} name={name} colour={colour} size={52} face={face} />
          <div className="mt-2 max-w-full break-words font-prose text-[15px] font-semibold text-text">
            {name}
          </div>
          {inspection?.description && (
            <p className="mt-0.5 text-[12px] leading-snug text-muted">{inspection.description}</p>
          )}
          <button
            type="button"
            onClick={onReveal}
            title={`Show agent folder in Finder (${dir})`}
            className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-card bg-surface px-2.5 py-1 text-[11px] text-muted ring-1 ring-stroke transition-colors hover:bg-hover hover:text-text"
          >
            <FolderSimple size={12} className="shrink-0" />
            <span className="break-all text-left font-mono leading-snug">{home(dir)}</span>
            <span className="sr-only">Show agent folder in Finder</span>
            <ArrowSquareOut size={11} className="shrink-0 opacity-70" />
          </button>
          {files.length > 0 && (
            <div className="mt-2 flex flex-wrap justify-center gap-1.5">
              {files.map((file) => (
                <button
                  key={file}
                  type="button"
                  onClick={() => onRevealPath(file)}
                  title={`Show ${file} in Finder`}
                  className="inline-flex items-center gap-1 rounded-[4px] bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-muted transition-colors hover:bg-hover hover:text-text"
                >
                  <FileText size={11} className="shrink-0" />
                  <span>{file}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {showModel && (
          <section className="space-y-1.5">
            <div className="flex items-center justify-between px-1">
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">
                <Cpu size={13} />
                <span>Default model</span>
              </h3>
            </div>
            <div className="rounded-card bg-surface px-3 py-2.5 ring-1 ring-stroke">
              <span
                className={`block break-all font-mono text-[12.5px] ${
                  model ? "font-medium text-text" : "text-muted"
                }`}
              >
                {model ?? "None set"}
              </span>
            </div>
          </section>
        )}

        <section className="space-y-1.5">
          <div className="flex items-center justify-between px-1">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">
              <FolderSimple size={13} />
              <span>Folders it works on</span>
            </h3>
            <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted tabular-nums">
              {content.length}
            </span>
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
                  title={`Show in Finder (${entry.location})`}
                  className="flex min-w-0 flex-1 items-start gap-2.5 py-2.5 pl-2.5 pr-1 text-left transition-colors hover:text-text"
                >
                  <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-[4px] bg-accent-weak text-accent">
                    <FolderSimple size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-[13px] font-medium text-text">{entry.name}</div>
                    <div className="mt-0.5 break-all font-mono text-[11px] leading-snug text-muted">
                      {home(entry.location)}
                    </div>
                  </div>
                </button>
                <Button
                  kind="ghost"
                  size={28}
                  onClick={() => void removeFolder(entry.name)}
                  disabled={disabledReason}
                  title={`Detach ${entry.name} (keeps files on disk)`}
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
              className={`${rowDivider} flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-medium text-accent transition-colors hover:bg-hover disabled:opacity-50`}
            >
              <Plus size={14} weight="bold" />
              <span>Add folder…</span>
            </button>
          </div>
        </section>

        <section className="space-y-1.5">
          <div className="flex items-center justify-between px-1">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">
              <Key size={13} />
              <span>Environment & secrets</span>
            </h3>
            <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted tabular-nums">
              {secrets.length + packages.length}
            </span>
          </div>
          {secretError && (
            <div role="alert" className="rounded-card bg-surface p-2.5 text-[12px] text-danger ring-1 ring-stroke">
              {secretError}
            </div>
          )}
          <div className="rounded-card bg-surface ring-1 ring-stroke overflow-hidden">
            {secrets.map((secret) =>
              editingSecret?.fixedName && editingSecret.name === secret.name ? (
                <div key={secret.name} className={`${rowDivider} flex items-center gap-1.5 py-1.5 pr-1.5 pl-3`}>
                  <span className="shrink-0 font-mono text-[12px] font-medium text-text">{secret.name}</span>
                  <span className="font-mono text-[12px] text-muted">=</span>
                  <input
                    type="password"
                    aria-label="Variable value"
                    placeholder="value"
                    value={editingSecret.value}
                    onChange={(e) => setEditingSecret({ ...editingSecret, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveSecret();
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setSecretError(undefined);
                        setEditingSecret(undefined);
                      }
                    }}
                    className="min-w-0 flex-1 rounded-[4px] bg-surface-2 px-2 py-1 font-mono text-[12px] text-text placeholder:text-muted/50 outline-none focus:ring-1 focus:ring-accent"
                    autoFocus
                  />
                  <Button
                    kind="ghost"
                    size={28}
                    aria-label="Save variable"
                    title="Save (Enter)"
                    disabled={disabledReason || (!editingSecret.value.trim() && "Enter a value")}
                    onClick={() => void saveSecret()}
                    icon={<Check size={14} className="text-accent" />}
                  />
                  <Button
                    kind="ghost"
                    size={28}
                    aria-label="Cancel"
                    title="Cancel (Esc)"
                    onClick={() => {
                      setSecretError(undefined);
                      setEditingSecret(undefined);
                    }}
                    icon={<X size={13} />}
                  />
                </div>
              ) : (
                <div
                  key={secret.name}
                  title={
                    secret.fromEnv
                      ? `${secret.name} is set in the process environment and overrides .secrets/.env`
                      : (secret.description ?? secret.declaredIn.join(", "))
                  }
                  className={`${rowDivider} flex items-center justify-between gap-2 py-2 pr-1.5 pl-3`}
                >
                  <button
                    type="button"
                    disabled={!!disabledReason || secret.fromEnv}
                    onClick={() => {
                      if (secret.fromEnv) return;
                      setSecretError(undefined);
                      setEditingSecret({ name: secret.name, value: "", fixedName: true });
                    }}
                    className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left disabled:cursor-default"
                  >
                    <span className="break-all font-mono text-[12px] font-medium text-text">{secret.name}</span>
                    {secret.configured && !secret.fromEnv && (
                      <span className="shrink-0 font-mono text-[11px] text-muted">••••••</span>
                    )}
                  </button>
                  {secret.fromEnv ? (
                    <Badge tone={secret.configured ? "muted" : "danger"}>
                      {secret.configured ? "from env" : "empty in env"}
                    </Badge>
                  ) : (
                    !secret.configured && (
                      <Badge tone={secret.optional ? "muted" : "danger"}>
                        {secret.optional ? "optional" : "missing"}
                      </Badge>
                    )
                  )}
                  {secret.fromFile && onRemoveSecret && (
                    <Button
                      kind="ghost"
                      size={28}
                      onClick={() => void deleteSecret(secret.name)}
                      disabled={disabledReason}
                      title={`Remove ${secret.name}`}
                      aria-label={`Remove ${secret.name}`}
                      icon={<X size={13} />}
                    />
                  )}
                </div>
              ),
            )}
            {packages.length > 0 && (
              <div className={`${rowDivider} flex flex-wrap items-center gap-1.5 px-3 py-2`}>
                <span className="text-[11px] text-muted">Packages:</span>
                {packages.map((pkg) => (
                  <span
                    key={pkg.name}
                    className="rounded-[4px] bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-text"
                  >
                    {pkg.name}
                    {pkg.version !== "latest" && pkg.version !== "system" ? `@${pkg.version}` : ""}
                  </span>
                ))}
              </div>
            )}
            {editingSecret && !editingSecret.fixedName ? (
              <div className={`${rowDivider} flex items-center gap-1.5 py-1.5 pr-1.5 pl-2.5`}>
                <input
                  type="text"
                  aria-label="Variable name"
                  placeholder="KEY"
                  value={editingSecret.name}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const eq = raw.indexOf("=");
                    if (eq > 0 && !editingSecret.value) {
                      let val = raw.slice(eq + 1).trim();
                      const quote = val[0];
                      if (val.length >= 2 && (quote === '"' || quote === "'") && val.at(-1) === quote) val = val.slice(1, -1);
                      setEditingSecret({
                        name: raw.slice(0, eq).trim(),
                        value: val,
                      });
                    } else {
                      setEditingSecret({ ...editingSecret, name: raw });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && editingSecret.name.trim() && editingSecret.value.trim()) void saveSecret();
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setSecretError(undefined);
                      setEditingSecret(undefined);
                    }
                  }}
                  className="w-[42%] shrink-0 rounded-[4px] bg-surface-2 px-2 py-1 font-mono text-[12px] text-text placeholder:text-muted/50 outline-none focus:ring-1 focus:ring-accent"
                  autoFocus
                />
                <span className="font-mono text-[12px] text-muted">=</span>
                <input
                  type="password"
                  aria-label="Variable value"
                  placeholder="value"
                  value={editingSecret.value}
                  onChange={(e) => setEditingSecret({ ...editingSecret, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && editingSecret.name.trim() && editingSecret.value.trim()) void saveSecret();
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setSecretError(undefined);
                      setEditingSecret(undefined);
                    }
                  }}
                  className="min-w-0 flex-1 rounded-[4px] bg-surface-2 px-2 py-1 font-mono text-[12px] text-text placeholder:text-muted/50 outline-none focus:ring-1 focus:ring-accent"
                />
                <Button
                  kind="ghost"
                  size={28}
                  aria-label="Save variable"
                  title="Save (Enter)"
                  disabled={
                    disabledReason ||
                    (!editingSecret.name.trim() && "Enter a variable name") ||
                    (!editingSecret.value.trim() && "Enter a value")
                  }
                  onClick={() => void saveSecret()}
                  icon={<Check size={14} className="text-accent" />}
                />
                <Button
                  kind="ghost"
                  size={28}
                  aria-label="Cancel"
                  title="Cancel (Esc)"
                  onClick={() => {
                    setSecretError(undefined);
                    setEditingSecret(undefined);
                  }}
                  icon={<X size={13} />}
                />
              </div>
            ) : (
              onSetSecret && (
                <button
                  type="button"
                  onClick={() => {
                    setSecretError(undefined);
                    setEditingSecret({ name: "", value: "" });
                  }}
                  disabled={!!disabledReason}
                  title={disabledReason || undefined}
                  className={`${rowDivider} flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-medium text-accent transition-colors hover:bg-hover disabled:opacity-50`}
                >
                  <Plus size={14} weight="bold" />
                  <span>Add variable…</span>
                </button>
              )
            )}
          </div>
        </section>

        <section className="space-y-1.5">
          <div className="flex items-center justify-between px-1">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">
              <Sparkle size={13} />
              <span>Skills</span>
            </h3>
            <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted tabular-nums">
              {skills.length}
            </span>
          </div>
          {skills.length > 0 ? (
            <div className="rounded-card bg-surface ring-1 ring-stroke overflow-hidden">
              {visibleSkills.map((skill) => {
                const skillName = skill.name.slice("skill:".length);
                const blocked = skillBlocked || disabledReason;
                return (
                  <button
                    key={skill.name}
                    type="button"
                    aria-disabled={Boolean(blocked) || undefined}
                    onClick={() => {
                      if (blocked) return;
                      onSelectSkill?.(skillName);
                    }}
                    title={typeof blocked === "string" ? blocked : `Click to use /skill:${skillName}`}
                    className={`${rowDivider} block w-full px-3 py-2 text-left transition-colors hover:bg-hover aria-disabled:opacity-50`}
                  >
                    <div className="font-mono text-[12.5px] font-medium text-accent">/skill:{skillName}</div>
                    {skill.description && (
                      <div className="mt-0.5 text-[12px] leading-snug text-muted">{skill.description}</div>
                    )}
                  </button>
                );
              })}
              {skills.length > SKILL_PREVIEW_LIMIT && (
                <button
                  type="button"
                  onClick={() => setShowAllSkills((open) => !open)}
                  className={`${rowDivider} flex w-full items-center justify-between px-3 py-2 text-left text-[12px] font-medium text-muted transition-colors hover:bg-hover hover:text-text`}
                >
                  <span>{showAllSkills ? "Show fewer" : `Show all ${skills.length} skills`}</span>
                  <CaretDown size={13} className={`transition-transform ${showAllSkills ? "rotate-180" : ""}`} />
                </button>
              )}
            </div>
          ) : (
            <div className="rounded-card bg-surface px-3 py-2 text-[12px] text-muted ring-1 ring-stroke">
              No skills in <span className="font-mono text-[11px]">skills/</span> yet.
            </div>
          )}
        </section>

        <section className="space-y-1.5">
          <div className="flex items-center justify-between px-1">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">
              <Wrench size={13} />
              <span>Tools</span>
            </h3>
            <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted tabular-nums">
              {tools.length}
            </span>
          </div>
          <div className="rounded-card bg-surface p-2.5 ring-1 ring-stroke">
            {tools.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {tools.map((tool) => (
                  <span
                    key={tool.name}
                    title={tool.description}
                    className="rounded-[4px] bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-text"
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

        {onRemove && (
          <div className="flex justify-center pt-1">
            <Button
              kind="danger"
              size={28}
              disabled={disabledReason}
              icon={<Trash size={13} />}
              onClick={onRemove}
            >
              Remove agent…
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}
