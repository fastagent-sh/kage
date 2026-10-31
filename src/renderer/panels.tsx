import { ArrowClockwise, FolderOpen, FolderSimplePlus, ArrowCounterClockwise, Plus, X } from "@phosphor-icons/react";
import { Button } from "./ui.tsx";
import { Page, Problem } from "./problem.tsx";
import { home } from "./paths.ts";

export function NoAgents({ onAdd }: { onAdd: () => void }) {
  return (
    <Page
      tone="accent"
      icon={<Plus size={18} />}
      title="Add your first agent"
      advice="duang runs the agents you already have. Choose an agent's folder, or a project to make one in."
      actions={
        <Button kind="primary" size={32} onClick={onAdd}>
          Add an agent directory
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
  onLocate,
  onRemove,
  onRetry,
}: {
  dir: string;
  onLocate: () => void;
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
          duang last found it at <span className="font-mono text-[12.5px]">{home(dir)}</span>. If it was moved,
          show duang where it is now: the agent keeps its name and conversations. If it is on a drive, connect it
          and retry.
        </>
      }
      actions={
        <>
          <Button kind="primary" size={32} icon={<FolderOpen size={14} />} onClick={onLocate}>
            Locate folder…
          </Button>
          <Button size={32} icon={<ArrowClockwise size={14} />} onClick={onRetry}>
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

export function NeedsAgent({ dir, onCreate, onRemove }: { dir: string; onCreate: () => void; onRemove: () => void }) {
  return (
    <Page
      tone="accent"
      icon={<FolderSimplePlus size={18} />}
      title="This folder has no agent yet"
      advice={
        <>
          duang can make this folder an agent: FastAgent&apos;s starter files and a git repository. An agent lives
          in a folder of its own, so the folder has to be empty.
        </>
      }
      actions={
        <>
          <Button kind="primary" size={32} onClick={onCreate}>
            Create agent here
          </Button>
          <Button kind="danger" size={32} icon={<X size={14} />} onClick={onRemove}>
            Remove
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-left">
        <pre className="rounded-card bg-surface-2 p-3 font-mono text-[12.5px] text-muted">
          {`${home(dir)}/\n  SYSTEM.md\n  fastagent.config.ts\n  skills/\n  package.json\n  .gitignore`}
        </pre>
        <p className="text-[12px] text-muted">
          A folder that already holds files is refused with FastAgent&apos;s reason, and nothing in it is touched.
        </p>
      </div>
    </Page>
  );
}

export function NewConversation() {
  return (
    <div className="flex-1 min-h-0 grid place-items-center px-6">
      <h1 className="column text-center text-[22px] font-medium">What should we work on?</h1>
    </div>
  );
}
