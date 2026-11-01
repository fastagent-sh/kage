import { Fragment } from "react";
import { ListBullets } from "@phosphor-icons/react";
import type { AgentContent, ProviderUsage } from "../preload/index.ts";
import { location } from "./paths.ts";
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
  list?: { open: boolean; unseen: number };
  onReveal: () => void;
  onRevealPath?: (path: string) => void;
  onUsagePage: (provider: string) => void;
}) {
  return (
    // Floats over the scroll area, so it lets the wheel through; only interactive parts take the pointer.
    <header className="pointer-events-none absolute inset-x-4 top-2 z-10">
      <div className="flex items-stretch gap-2">
        <div className="conversation-header flex min-w-0 flex-1 items-center gap-2.5 rounded-composer bg-surface/75 py-1.5 pr-4 pl-2 ring-1 ring-stroke backdrop-blur-xl">
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
                <button
                  onClick={onReveal}
                  title={dir}
                  className="pointer-events-auto block max-w-full truncate text-left text-[11px] text-muted hover:text-text"
                >
                  {location(dir)}
                </button>
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
