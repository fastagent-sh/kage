import { ArrowClockwise, ArrowUp, FolderOpen, Plug, Plus, Stop, Swap, Trash, X } from "@phosphor-icons/react";
import { Badge, Button } from "./ui.tsx";
import { Problem } from "./problem.tsx";
import { BrokenAgent, MissingFolder } from "./panels.tsx";
import { Avatar } from "./avatar.tsx";
import type { Face } from "./face.ts";
import { CodeBlock } from "./code.tsx";
import { UsageDetail, UsageMeter } from "./plan-usage.tsx";
import { Message, RunStatus, Tool, WorkBlock } from "./transcript-view.tsx";

const FIXED = new Date(2026, 0, 5, 9, 41).getTime();

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-medium">{title}</h2>
        {note && <p className="text-muted text-[11px]">{note}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

export default function Gallery() {
  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="column space-y-8">
        <header>
          <h1 className="text-[22px] font-medium">
            kage<span className="text-accent">·</span> components
          </h1>
          <p className="text-muted text-[12px]">docs/ui.md §6b. Every section renders the real components.</p>
        </header>

        <Section
          title="Buttons — kinds"
          note="primary at most once per screen; danger is quiet until the pointer is on it"
        >
          <Button kind="primary">Create agent</Button>
          <Button>Reveal in Finder</Button>
          <Button kind="ghost">Retry</Button>
          <Button kind="danger" icon={<X size={14} />}>
            Remove agent
          </Button>
        </Section>

        <Section title="Buttons — heights" note="28 inside rows and dense bars, 32 standing on its own, 40 round in the composer and header">
          <Button size={32}>32 — on its own</Button>
          <Button size={28}>28 — in a row</Button>
          <Button size={32} icon={<Plus size={16} />} aria-label="Add" />
          <Button size={28} icon={<FolderOpen size={14} />} aria-label="Reveal" />
          <Button size={28} kind="danger" icon={<Trash size={13} />} aria-label="Delete" />
          <Button size={28} kind="primary" icon={<ArrowUp size={15} />} aria-label="Send" />
          <Button size={40} kind="primary" icon={<ArrowUp size={18} />} aria-label="Send message" />
        </Section>

        <Section title="Buttons — disabled" note="the prop takes the reason, so nothing greys out silently">
          <Button kind="primary" size={28} icon={<ArrowUp size={15} />} disabled="Select an agent first" />
          <Button kind="ghost" size={28} disabled="Stop the turn to change the model or effort" className="font-mono">
            anthropic/claude-sonnet-5
          </Button>
          <Button disabled="This agent is not ready">Reveal in Finder</Button>
        </Section>

        <Section title="Context and plan usage" note="the header's right edge is the context; hover opens the plan's windows, their reset and pace, and the context's size">
          {(() => {
            const now = Date.UTC(2026, 8, 23, 12);
            const plan = (week: number) => ({
              data: {
                provider: "anthropic",
                fetchedAt: now - 60_000,
                windows: [
                  { label: "5h", percent: 4, resetsAt: now + 2.5 * 3600_000, windowSeconds: 5 * 3600 },
                  { label: "7d", percent: week, resetsAt: now + 1.7 * 86_400_000, windowSeconds: 7 * 86_400 },
                ],
              },
            });
            const context = { used: 451_000, window: 1_000_000 };
            return (
              <div className="flex items-start gap-8">
                <div className="space-y-2">
                  <UsageMeter plan={plan(18)} context={context} now={now} />
                  <UsageMeter plan={plan(88)} context={{ used: 880_000, window: 1_000_000 }} now={now} />
                  <UsageMeter plan={plan(18)} now={now} />
                </div>
                <div className="popover">
                  <UsageDetail plan={plan(88)} context={context} now={now} />
                </div>
              </div>
            );
          })()}
        </Section>

        <Section title="Badges — the one status vocabulary" note="a mark and a word, never colour alone; pulse means still happening">
          <Badge tone="accent" pulse>
            working
          </Badge>
          <Badge tone="accent" pulse>
            2 working
          </Badge>
          <Badge tone="accent" pulse>
            running
          </Badge>
          <Badge tone="success">done</Badge>
          <Badge tone="danger">failed</Badge>
          <Badge tone="muted">stopped</Badge>
          <Badge tone="warning">refused</Badge>
          <Badge tone="danger">broken</Badge>
        </Section>

        <Section title="Avatars — one face per state" note="the drawing is who it is and never changes; the face is what it is doing; the words say it too">
          {(["idle", "open", "thinking", "tool", "answering", "done", "failed", "broken"] satisfies Face[]).map((face, colour) => (
            <div key={face} className="flex flex-col items-center gap-1.5 text-[11px] text-muted">
              <Avatar id={`gallery-${face}`} name={face} colour={colour} size={48} face={face} />
              {face}
            </div>
          ))}
        </Section>

        <Section title="Surfaces" note="flat reading surfaces; soft shadows on floating chrome and popovers">
          <div className="rounded-card bg-surface px-3 h-8 grid place-items-center text-[12px]">surface (card)</div>
          <div className="rounded-card bg-surface-2 px-3 h-8 grid place-items-center text-[12px]">surface-2</div>
          <div className="rounded-card ring-1 ring-stroke px-3 h-8 grid place-items-center text-[12px]">hairline</div>
          <div className="rounded-card bg-accent-weak text-accent px-3 h-8 grid place-items-center text-[12px]">
            accent-weak
          </div>
          <div className="popover px-3 h-8 grid place-items-center text-[12px]">popover</div>
        </Section>

        <Section title="Transcript pieces" note="a message each way, a finished and a failed tool call, a system line">
          <div className="w-full space-y-4">
            <Message item={{ kind: "user", text: "Run the i18n check and explain what broke", at: FIXED }} />
            <Message
              item={{
                kind: "assistant",
                text: "The check fails in `src/i18n/zh.json:12` ($O(1)$ lookup), and the cause is a missing key rather than the component.",
                open: false,
                at: FIXED,
              }}
            />
            <Tool
              item={{
                kind: "tool",
                id: "edit-1",
                name: "edit",
                args: {
                  path: "src/i18n/zh.json",
                  edits: [{ oldText: '  "title": "标题"\n}', newText: '  "title": "标题",\n  "heading": "概览"\n}' }],
                },
                result: "Successfully replaced 1 block(s) in src/i18n/zh.json.",
                status: "done",
                at: FIXED,
                started: FIXED,
                ended: FIXED + 420,
              }}
            />
            <Tool
              item={{
                kind: "tool",
                id: "a",
                name: "bash",
                args: { command: "bun run i18n:check" },
                result: "1 missing key",
                status: "done",
                at: FIXED,
                started: FIXED,
                ended: FIXED + 3_240,
              }}
            />
            <Tool
              item={{
                kind: "tool",
                id: "b",
                name: "bash",
                args: { command: "bun run build" },
                result: "exit 1",
                isError: true,
                status: "done",
                at: FIXED,
                started: FIXED,
                ended: FIXED + 61_000,
              }}
            />
            <Message item={{ kind: "note", tone: "info", text: "model changed to anthropic/claude-sonnet-5", at: FIXED }} />
            <CodeBlock language="typescript" code={'const t = useTranslations("AmazonListing");\nreturn t("heading");'} />
          </div>
        </Section>

        <Section
          title="Problems — in the transcript"
          note="docs/ui.md §9b: what it means, what to do, the way on, and the original words out of the way; a fact about the session stays one quiet line"
        >
          <div className="w-full space-y-4">
            <Problem
              tone="error"
              title="The provider did not accept the sign-in"
              advice="The key or sign-in may have expired or been revoked. Sign in again, then retry."
              reason={'OpenAI API error (401): {"message":"Incorrect API key provided: sk-proj-****. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error"}'}
              actions={
                <>
                  <Button kind="secondary" size={28} icon={<Plug size={12} />}>
                    Sign in to OpenAI again
                  </Button>
                  <Button kind="secondary" size={28} icon={<ArrowClockwise size={12} />}>
                    Retry
                  </Button>
                </>
              }
            />
            <Problem
              tone="error"
              title="The provider had a problem"
              advice="This is usually brief. Retry in a moment, or use another model."
              reason={'OpenAI API error (529): {"message":"The server is overloaded. Please try again later.","type":"server_error"}'}
              actions={
                <>
                  <Button kind="secondary" size={28} icon={<Swap size={12} />}>
                    Use another model
                  </Button>
                  <Button kind="secondary" size={28} icon={<ArrowClockwise size={12} />}>
                    Retry
                  </Button>
                </>
              }
            />
            <Problem
              tone="error"
              title="This run was cut short"
              advice="kage or the computer stopped before an answer was recorded. What it did up to here is kept."
            />
            <Message item={{ kind: "note", tone: "info", text: "run stopped", at: FIXED }} />
            <Message item={{ kind: "note", tone: "info", text: "retrying 1/3: could not reach the provider", at: FIXED }} />
          </div>
        </Section>

        <Section title="Problems — over the pane and in place of it" note="a strip floats under the header and never moves the transcript; a page stands in for what cannot be shown">
          <div className="w-full space-y-4">
            <Problem
              layout="strip"
              tone="error"
              title="The agent was not renamed"
              reason="EACCES: permission denied, rename '~/Library/Application Support/kage/agents.json.tmp' -> '~/Library/Application Support/kage/agents.json'"
              onDismiss={() => {}}
            />
            <Problem
              layout="strip"
              tone="info"
              title="This conversation stopped updating"
              advice="Nothing was lost. Reconnect to follow it again."
              actions={
                <Button kind="secondary" size={28} icon={<ArrowClockwise size={12} />}>
                  Reconnect
                </Button>
              }
            />
            <div className="flex rounded-float ring-1 ring-stroke">
              <BrokenAgent
                message={"~/Agents/research/fastagent.config.ts: Unexpected token '}' (12:3)\n  10 |   model: \"anthropic/claude-sonnet-4-5\",\n  11 |   tools: [\"read\", \"bash\"\n> 12 | }\n     |   ^"}
                inConfig
                onFreshConfig={() => {}}
                onForgetModel={() => {}}
                onRemove={() => {}}
                onReveal={() => {}}
                onRetry={() => {}}
              />
            </div>
            <div className="flex rounded-float ring-1 ring-stroke">
              <MissingFolder dir="/Users/someone/Agents/video-research" onRemove={() => {}} onRetry={() => {}} />
            </div>
          </div>
        </Section>

        <Section
          title="Work and the live status"
          note="a stretch of tool calls reads as one line of what kind of work it was; the live end of a run says what it is on now"
        >
          <div className="w-full space-y-3">
            <WorkBlock
              work={{
                kind: "work",
                items: [
                  { kind: "thinking", text: "", open: false, started: FIXED, at: FIXED + 6_000 },
                  ...["a.ts", "b.ts", "c.ts", "d.ts"].map((file, index) => ({
                    kind: "tool" as const,
                    id: file,
                    name: "read",
                    args: { path: `/src/${file}` },
                    status: "done" as const,
                    at: FIXED + index,
                  })),
                  { kind: "tool", id: "g", name: "grep", args: { pattern: "sectionsGenerated" }, status: "done", at: FIXED },
                  { kind: "tool", id: "t", name: "bash", args: { command: "npm test" }, isError: true, status: "done", at: FIXED },
                ],
              }}
            />
            <RunStatus
              items={[{ kind: "tool", id: "r", name: "bash", args: { command: "npm run build" }, status: "running", at: FIXED }]}
              status="running"
            />
            <RunStatus
              items={[{ kind: "thinking", text: "The check fails fast, so the answer should not depend on it.", open: true, started: FIXED, at: FIXED }]}
              status="running"
            />
          </div>
        </Section>

        <Section title="Icon-only, where the symbol is universal" note="loud fills the kind — Stop has to be found instantly">
          <Button size={28} kind="primary" icon={<ArrowUp size={15} />} aria-label="Send" />
          <Button size={28} kind="danger" loud icon={<Stop size={13} weight="fill" />} aria-label="Stop" />
          <Button size={28} kind="ghost" icon={<X size={14} />} aria-label="Close" />
        </Section>
      </div>
    </div>
  );
}
