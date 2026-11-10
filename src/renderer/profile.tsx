import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CaretDown,
  CaretLeft,
  CaretRight,
  ChatCircle,
  Check,
  FileText,
  FolderOpen,
  FolderSimple,
  Key,
  Plus,
  Sparkle,
  Trash,
  WarningCircle,
  Wrench,
  X,
} from "@phosphor-icons/react";
import type { AgentCapability, AgentContent, AgentInspection } from "../preload/index.ts";
import { Avatar } from "./avatar.tsx";
import type { Face } from "./face.ts";
import { explainContentError } from "./panels.tsx";
import { home } from "./paths.ts";
import { Badge, Button } from "./ui.tsx";

const rowDivider =
  "relative [&+&]:before:content-[''] [&+&]:before:absolute [&+&]:before:top-0 [&+&]:before:right-0 [&+&]:before:left-3 [&+&]:before:h-px [&+&]:before:bg-stroke";

const SKILL_PREVIEW_LIMIT = 3;

export function AgentProfile({
  id,
  name,
  colour,
  face,
  dir,
  model,
  showModel,
  modelBlocked,
  skillBlocked,
  content = [],
  commands = [],
  tools = [],
  inspection,
  busy,
  loading,
  onClose,
  onChangeModel,
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
  modelBlocked?: string;
  skillBlocked?: string;
  content?: AgentContent[];
  commands?: AgentCapability[];
  tools?: AgentCapability[];
  inspection?: AgentInspection;
  busy: boolean;
  loading?: boolean;
  onClose: () => void;
  onChangeModel: () => void;
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
  const [editingSecret, setEditingSecret] = useState<{ name: string; value: string }>();
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

  return (
    <section id="agent-info" aria-label="Agent details" className="relative flex min-h-0 flex-1 flex-col">
      <div className="absolute inset-x-0 top-0 z-10 h-10 drag" />
      <Button
        kind="secondary"
        size={40}
        onClick={onClose}
        aria-label="Close agent details"
        title="Back (Esc)"
        icon={<CaretLeft size={17} />}
        className="no-drag absolute top-2 left-3 z-20 bg-surface/85 backdrop-blur-xl"
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[600px] space-y-3 px-6 pt-8 pb-10">
          <div className="flex flex-col items-center px-2 pb-1 text-center">
            <Avatar id={id} name={name} colour={colour} size={96} face={face} />
            <h1 className="mt-3 max-w-full break-words font-prose text-[22px] font-semibold text-text">{name}</h1>
            {inspection?.description && (
              <p className="mt-0.5 max-w-prose text-[13px] leading-snug text-muted">{inspection.description}</p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <ActionTile icon={<ChatCircle size={22} weight="fill" />} label="Message" onClick={onClose} />
            <ActionTile
              icon={<FolderOpen size={22} weight="fill" />}
              label="Show folder"
              title={`Show agent folder in Finder (${dir})`}
              onClick={onReveal}
            />
            {onRemove && (
              <ActionTile
                danger
                icon={<Trash size={22} weight="fill" />}
                label="Remove…"
                disabled={disabledReason}
                onClick={onRemove}
              />
            )}
          </div>

          <div className={`${card} divide-y divide-stroke`}>
            <InfoRow label="folder">
              <button
                type="button"
                onClick={onReveal}
                title={`Show agent folder in Finder (${dir})`}
                className="break-all text-left font-mono text-[12.5px] text-text hover:text-accent"
              >
                {home(dir)}
              </button>
              {files.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
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
            </InfoRow>
            {showModel && (
              <InfoRow label="default model">
                <button
                  type="button"
                  aria-disabled={modelBlocked ? true : undefined}
                  title={modelBlocked ?? "Choose the model in the conversation"}
                  onClick={modelBlocked ? undefined : onChangeModel}
                  className={`flex w-full items-center justify-between gap-2 text-left ${modelBlocked ? "opacity-50" : "hover:text-accent"}`}
                >
                  <span className={`break-all font-mono text-[12.5px] ${model ? "text-text" : "text-muted"}`}>
                    {model ?? "None set"}
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5 text-[12px] text-accent">
                    Change
                    <CaretRight size={12} />
                  </span>
                </button>
              </InfoRow>
            )}
          </div>

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
            <div className={card}>
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

          {secrets.length > 0 && (
            <section className="space-y-1.5">
              <div className="flex items-center justify-between px-1">
                <h3 className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">
                  <Key size={13} />
                  <span>Environment & secrets</span>
                </h3>
                <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted tabular-nums">
                  {secrets.length}
                </span>
              </div>
              {secretError && (
                <div role="alert" className="rounded-card bg-surface p-2.5 text-[12px] text-danger ring-1 ring-stroke">
                  {secretError}
                </div>
              )}
              <div className={card}>
                {secrets.map((secret) =>
                  editingSecret?.name === secret.name ? (
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
                            e.preventDefault();
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
                      title={secret.description ?? secret.declaredIn.join(", ")}
                      className={`${rowDivider} flex items-center justify-between gap-2 py-2 pr-1.5 pl-3`}
                    >
                      <button
                        type="button"
                        disabled={!!disabledReason}
                        onClick={() => {
                          setSecretError(undefined);
                          setEditingSecret({ name: secret.name, value: "" });
                        }}
                        className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left disabled:cursor-default"
                      >
                        <span className="break-all font-mono text-[12px] font-medium text-text">{secret.name}</span>
                        {secret.configured && <span className="shrink-0 font-mono text-[11px] text-muted">••••••</span>}
                      </button>
                      {!secret.configured && (
                        <Badge tone={secret.optional ? "muted" : "danger"}>{secret.optional ? "optional" : "missing"}</Badge>
                      )}
                      {secret.configured && onRemoveSecret && (
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
              </div>
            </section>
          )}

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
              <div className={card}>
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
        </div>
      </div>
    </section>
  );
}

const card = "rounded-float bg-surface ring-1 ring-stroke overflow-hidden";

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-4 py-3">
      <div className="mb-0.5 text-[12px] text-accent">{label}</div>
      {children}
    </div>
  );
}

function ActionTile({
  icon,
  label,
  title,
  danger,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  title?: string;
  danger?: boolean;
  disabled?: string | false;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-disabled={disabled ? true : undefined}
      title={disabled || title}
      onClick={disabled ? undefined : onClick}
      className={`flex flex-col items-center gap-1.5 rounded-float bg-surface px-2 py-3 text-[12px] ring-1 ring-stroke transition-colors ${
        danger ? "text-danger" : "text-accent"
      } ${disabled ? "opacity-40" : "hover:bg-hover"}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
