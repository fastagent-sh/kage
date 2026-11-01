import { useState } from "react";
import { ArrowClockwise, FolderOpen, ArrowCounterClockwise, Plus, X } from "@phosphor-icons/react";
import { Avatar } from "./avatar.tsx";
import { Button } from "./ui.tsx";
import { Page, Problem } from "./problem.tsx";
import { home } from "./paths.ts";

export function NoAgents({ onCreate }: { onCreate: () => void }) {
  return (
    <Page
      tone="accent"
      icon={<Plus size={18} />}
      title="Create your first agent"
      advice={
        <>
          Give an agent a name and the folders it works on. duang creates it in{" "}
          <span className="font-mono text-[12.5px]">~/Agents/</span>.
        </>
      }
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
          duang last found it at <span className="font-mono text-[12.5px]">{home(dir)}</span>. If it was on a drive,
          connect it and retry; otherwise remove the agent from duang.
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

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-16 pb-6">
      <form
        aria-label="Create agent"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="mx-auto mt-8 max-w-md space-y-5"
      >
        <div className="space-y-1">
          <h2 className="text-[22px] font-medium">Create agent</h2>
          <p className="text-[13px] text-muted">
            Created in <span className="font-mono text-[12.5px]">~/Agents/</span> with FastAgent&apos;s starter files and a git repository.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Avatar id="create-agent" name={name.trim() || "Agent"} colour={colour} size={40} face="idle" />
          <input
            autoFocus
            aria-label="Agent name"
            placeholder="Agent name"
            value={name}
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
              setError(undefined);
            }}
            className="h-10 min-w-0 flex-1 rounded-card bg-surface px-3 font-prose text-[15px] outline-none ring-1 ring-stroke focus:ring-accent"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-muted">Contexts</span>
            <Button
              size={28}
              icon={<Plus size={13} />}
              disabled={busy && "Creating the agent…"}
              onClick={() => void addFolder()}
            >
              Add folder…
            </Button>
          </div>
          {folders.length === 0 ? (
            <div className="code-block rounded-card bg-surface px-3.5 py-3 text-[12px] text-muted">
              Add a folder on this computer for the agent to work on, or leave this empty so it works only in its own directory.
            </div>
          ) : (
            <div className="code-block divide-y divide-stroke rounded-card bg-surface">
              {folders.map((folder, index) => (
                <div key={`${folder.path}-${index}`} className="flex items-center gap-2.5 px-3 py-2">
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
                    title="Remove"
                    disabled={busy && "Creating the agent…"}
                    icon={<X size={13} />}
                    onClick={() => removeFolder(index)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <Problem tone="error" title="The agent could not be created" reason={error} />}

        <div className="flex justify-end gap-2 pt-1">
          <Button size={32} disabled={busy && "Creating the agent…"} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            kind="primary"
            size={32}
            disabled={!name.trim() ? "Enter an agent name" : busy ? "Creating the agent…" : undefined}
            onClick={() => void submit()}
          >
            Create agent
          </Button>
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
