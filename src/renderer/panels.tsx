import { useState } from "react";
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
      advice="Give it a name and the folders on this Mac you want it to work on."
      actions={
        <Button kind="primary" size={32} onClick={onCreate}>
          Create agent
        </Button>
      }
    />
  );
}

// Never repair the file: the broken one may be the only record of which directories are agents.
export function UnreadableRegistry({ reason, onReveal, onRetry }: { reason?: string; onReveal: () => void; onRetry: () => void }) {
  return (
    <Problem
      layout="page"
      tone="error"
      title="duang cannot read its list of agents"
      advice="Your agents and their conversations are untouched, and the file is left exactly as it is. Fix or move it, then retry."
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
  onFreshConfig,
  onRemove,
  onReveal,
  onRetry,
}: {
  message: string;
  inConfig?: boolean;
  onFreshConfig: () => void;
  onRemove: () => void;
  onReveal: () => void;
  onRetry: () => void;
}) {
  return (
    <Problem
      layout="page"
      tone="error"
      title="This agent could not be loaded"
      advice={
        inConfig
          ? "Its fastagent.config.ts, or a file it imports, does not load. Fix it and retry, or start a fresh config and choose a model again: duang keeps a copy of the old one beside it, as fastagent.config.ts.broken-<time>."
          : "Something in its definition stops it from starting. Fix it in the agent's folder, then retry; duang has changed nothing."
      }
      reason={message}
      actions={
        <>
          {inConfig && (
            <Button kind="primary" size={32} icon={<ArrowCounterClockwise size={14} />} onClick={onFreshConfig}>
              Start a fresh config
            </Button>
          )}
          <Button kind={inConfig ? "secondary" : "primary"} size={32} icon={<ArrowClockwise size={14} />} onClick={onRetry}>
            Retry
          </Button>
          <Button size={32} icon={<FolderOpen size={14} />} onClick={onReveal}>
            Reveal in Finder
          </Button>
          <Button kind="danger" size={32} icon={<X size={14} />} onClick={onRemove}>
            Remove from duang
          </Button>
        </>
      }
    />
  );
}

// Retry covers a drive coming back.
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
          duang last found it at <span className="font-mono text-[12.5px]">{home(dir)}</span>. If it was on an external
          drive, connect the drive and retry; otherwise remove the agent from duang.
        </>
      }
      actions={
        <>
          <Button kind="primary" size={32} icon={<ArrowClockwise size={14} />} onClick={onRetry}>
            Retry
          </Button>
          <Button kind="danger" size={32} icon={<X size={14} />} onClick={onRemove}>
            Remove from duang
          </Button>
        </>
      }
    />
  );
}

function explainCreateError(reason: string): { title: string; advice?: string } {
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
  return { title: "The agent could not be created" };
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
    const picked = await onPickFolder();
    if (!picked) return;
    setFolders((current) => [...current, picked]);
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
  const explained = error ? explainCreateError(error) : undefined;

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
                    <div className="truncate text-[13px] font-medium">{folder.name}</div>
                    <div className="truncate font-mono text-[12.5px] text-muted" title={folder.path}>
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

export function NewConversation() {
  return (
    <div className="flex-1 min-h-0 grid place-items-center px-6">
      <h1 className="column text-center text-[22px] font-medium">What should we work on?</h1>
    </div>
  );
}
