import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, FolderOpen, ArrowCounterClockwise, Plus, X } from "@phosphor-icons/react";
import { Avatar } from "./avatar.tsx";
import { Button } from "./ui.tsx";
import { Page, Problem } from "./problem.tsx";
import { agentSlug, home } from "./paths.ts";
import { row } from "./settings.tsx";

export function NoAgents({ onCreate }: { onCreate: () => void }) {
  return (
    <Page
      tone="accent"
      icon={<Plus size={18} />}
      title="Create your first agent"
      advice="Give it a name. Add project folders if needed."
      actions={
        <Button kind="primary" size={32} onClick={onCreate}>
          Create agent
        </Button>
      }
    />
  );
}

export function UnreadableRegistry({ reason, onReveal, onRetry }: { reason?: string; onReveal: () => void; onRetry: () => void }) {
  return (
    <Problem
      layout="page"
      tone="error"
      title="kage cannot read its list of agents"
      advice="kage has left the file unchanged. Restore a valid copy if you have one, or repair the file, then retry. Your Agent folders and conversations have not been changed."
      reason={reason}
      actions={
        <>
          <Button kind="primary" size={32} icon={<FolderOpen size={14} />} onClick={onReveal}>
            Reveal agents.json
          </Button>
          <Button size={32} icon={<ArrowClockwise size={14} />} onClick={onRetry}>
            Retry
          </Button>
        </>
      }
    />
  );
}

export function BrokenAgent({
  message,
  inConfig,
  unknownModel,
  onFreshConfig,
  onForgetModel,
  onRemove,
  onReveal,
  onRetry,
}: {
  message: string;
  inConfig?: boolean;
  unknownModel?: string;
  onFreshConfig: () => void;
  onForgetModel: () => void;
  onRemove: () => void;
  onReveal: () => void;
  onRetry: () => void;
}) {
  return (
    <Problem
      layout="page"
      tone="error"
      title={inConfig && !unknownModel ? "This agent’s config could not be loaded" : "This agent could not be loaded"}
      advice={
        unknownModel
          ? `Its default model, ${unknownModel}, is no longer offered. Forget it to open the agent, then choose another model; its folders and conversations are untouched.`
          : inConfig
          ? "Fix fastagent.json, then retry."
          : "Something in its definition stops it from starting. Fix it in the agent's folder, then retry; kage has changed nothing."
      }
      reason={message}
      actions={
        <>
          {unknownModel && (
            <Button kind="primary" size={32} icon={<ArrowCounterClockwise size={14} />} onClick={onForgetModel}>
              Forget {unknownModel}
            </Button>
          )}
          <Button kind={inConfig && !unknownModel ? "primary" : "secondary"} size={32} icon={<FolderOpen size={14} />} onClick={onReveal}>
            Reveal in Finder
          </Button>
          <Button kind={!inConfig && !unknownModel ? "primary" : "secondary"} size={32} icon={<ArrowClockwise size={14} />} onClick={onRetry}>
            Retry
          </Button>
          {inConfig && !unknownModel && (
            <div className="w-full space-y-2 pt-4">
              <Button size={32} icon={<ArrowCounterClockwise size={14} />} onClick={onFreshConfig} aria-describedby="fresh-config-consequences">
                Start a fresh config
              </Button>
              <p id="fresh-config-consequences" className="text-[13px] leading-relaxed text-muted">
                Keeps the original as <span className="break-all">fastagent.json.broken-&lt;time&gt;</span>. You’ll need to choose a model and add the folders again. Existing files and conversations are kept.
              </p>
            </div>
          )}
          <div className="w-full pt-2">
            <Button kind="danger" size={32} icon={<X size={14} />} onClick={onRemove}>
              Remove from kage
            </Button>
          </div>
        </>
      }
    />
  );
}

export function MissingFolder({
  dir,
  onRemove,
  onRetry,
}: {
  dir: string;
  onRemove: () => void;
  onRetry: () => void;
}) {
  return (
    <Problem
      layout="page"
      tone="error"
      title="This agent's folder is not there"
      advice={
        <>
          kage last found this agent at <span className="break-all font-mono text-[12.5px]">{home(dir)}</span>. Reconnect its drive,
          or restore the folder to this location, then retry. Remove it from kage only if you no longer need it.
        </>
      }
      actions={
        <>
          <Button kind="primary" size={32} icon={<ArrowClockwise size={14} />} onClick={onRetry}>
            Retry
          </Button>
          <Button kind="danger" size={32} icon={<X size={14} />} onClick={onRemove}>
            Remove from kage
          </Button>
        </>
      }
    />
  );
}

export function explainContentError(reason: string, fallbackTitle = "The agent could not be created"): { title: string; advice?: string } {
  const duplicate = /already has content named "([^"]+)"/.exec(reason);
  if (duplicate) {
    return {
      title: `Two folders are named “${duplicate[1]}”`,
      advice: "Each folder attached to an agent needs its own name. Remove one of them to continue.",
    };
  }
  if (reason.includes("contains the agent directory") || reason.includes("is inside the agent directory")) {
    return {
      title: "This folder overlaps with ~/Agents/",
      advice: "Choose a project folder outside ~/Agents/ so the agent and the files it works on stay separate.",
    };
  }
  if (reason.includes("cannot name content")) {
    return {
      title: "This folder's name cannot be used",
      advice: "Rename the folder to use letters, numbers, hyphens, or underscores, then add it again.",
    };
  }
  return { title: fallbackTitle };
}

export function CreateAgent({
  colour,
  onPickFolder,
  onCreate,
  onCancel,
}: {
  colour: number;
  onPickFolder: () => Promise<{ name: string; path: string } | undefined>;
  onCreate: (name: string, folders: string[]) => Promise<string | undefined>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<{ name: string; path: string }[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const addFolder = async () => {
    setError(undefined);
    try {
      const picked = await onPickFolder();
      if (!picked) return;
      setFolders((current) => [...current, picked]);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const removeFolder = (index: number) => {
    setError(undefined);
    setFolders((current) => current.filter((_, i) => i !== index));
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const refusal = await onCreate(trimmed, folders.map((f) => f.path));
      if (refusal) setError(refusal);
    } finally {
      setBusy(false);
    }
  };

  const trimmed = name.trim();
  const folderHint = trimmed ? `~/Agents/${agentSlug(trimmed)}` : "~/Agents/";
  const explained = error ? explainContentError(error) : undefined;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <form
        aria-label="Create agent"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="mx-auto max-w-[520px] px-6 pt-6 pb-10"
      >
        <h1 className="mb-5 text-[22px] font-medium drag">Create agent</h1>

        <div className="space-y-6">
          <label className="flex cursor-text items-center gap-3.5 rounded-float bg-surface px-4 py-3 ring-1 ring-stroke transition-shadow focus-within:ring-accent/60">
            <Avatar id="create-agent" name={trimmed || "Agent"} colour={colour} size={44} face="idle" />
            <div className="min-w-0 flex-1">
              <input
                autoFocus
                aria-label="Agent name"
                placeholder="Name your agent…"
                value={name}
                disabled={busy}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(undefined);
                }}
                className="w-full bg-transparent font-prose text-[15px] font-semibold outline-none placeholder:font-normal placeholder:text-muted"
              />
              <div className="mt-0.5 truncate font-mono text-[11px] text-muted">{folderHint}</div>
            </div>
          </label>

          <section aria-labelledby="folders-heading" className="space-y-1.5">
            <div className="flex items-baseline justify-between px-4 text-[12px]">
              <h2 id="folders-heading" className="font-medium text-muted">
                Folders it works on
              </h2>
              <span className="text-[11px] text-muted">Optional</span>
            </div>
            <div className="overflow-hidden rounded-float bg-surface ring-1 ring-stroke">
              {folders.map((folder, index) => (
                <div key={`${folder.path}-${index}`} className={`${row} flex items-center gap-3 px-4 py-2.5`}>
                  <FolderOpen size={15} className="shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-[13px] font-medium">{folder.name}</div>
                    <div className="break-all font-mono text-[12.5px] leading-snug text-muted" title={folder.path}>
                      {home(folder.path)}
                    </div>
                  </div>
                  <Button
                    kind="ghost"
                    size={28}
                    aria-label={`Remove ${folder.name}`}
                    title="Remove folder"
                    disabled={busy && "Creating the agent…"}
                    icon={<X size={13} />}
                    onClick={() => removeFolder(index)}
                  />
                </div>
              ))}
              <button
                type="button"
                disabled={busy}
                onClick={() => void addFolder()}
                className={`${folders.length ? row : ""} flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[13px] text-accent transition-colors hover:bg-hover disabled:opacity-40`}
              >
                <Plus size={15} className="shrink-0" aria-hidden />
                <span>Add folder…</span>
              </button>
            </div>
          </section>

          {error && explained && (
            <Problem tone="error" title={explained.title} advice={explained.advice} reason={error} />
          )}

          <div className="flex items-center justify-end gap-2">
            <button type="submit" hidden />
            <Button size={32} disabled={busy && "Creating the agent…"} onClick={onCancel}>
              Cancel
            </Button>
            <Button
              kind="primary"
              size={32}
              disabled={!trimmed ? "Enter an agent name" : busy ? "Creating the agent…" : undefined}
              onClick={() => void submit()}
            >
              Create agent
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

export function NewConversation({
  needsModel,
  bottomGap,
  onChooseModel,
}: {
  needsModel: boolean;
  bottomGap: number;
  onChooseModel: () => void;
}) {
  const neededModel = useRef(needsModel);
  useEffect(() => {
    const chosen = neededModel.current && !needsModel;
    neededModel.current = needsModel;
    if (!chosen) return;
    const frame = requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('main textarea[aria-label="Message"]')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [needsModel]);
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6">
      <div className="conversation-start grid min-h-full place-items-center pt-24" style={{ paddingBottom: bottomGap + 24 }}>
        <div className="column flex flex-col items-center gap-3 py-4 text-center">
          <h1 className="text-[22px] font-medium">{needsModel ? "Choose a model to start." : "What should we work on?"}</h1>
          {needsModel && (
            <Button kind="primary" onClick={onChooseModel}>
              Choose model
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
