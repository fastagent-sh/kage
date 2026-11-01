import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DuangApi } from "../preload/index.ts";
import { createStore } from "./store.ts";
import { rows } from "./sessions.ts";
import { contextUsed } from "./conversation.ts";
import { queueView } from "./transcript.ts";
import { providerOf } from "./catalog.ts";
import { BrokenAgent, CreateAgent, MissingFolder, NewConversation, NoAgents, UnreadableRegistry } from "./panels.tsx";
import { Problem } from "./problem.tsx";
import { ArrowClockwise } from "@phosphor-icons/react";
import { ConversationList, Sidebar } from "./rows.tsx";
import { AgentInspector, ConversationHeader } from "./header.tsx";
import { Transcript } from "./transcript-view.tsx";
import { Composer } from "./composer.tsx";
import { Settings } from "./settings.tsx";
import { AvatarStyleContext } from "./avatar.tsx";
import { faceOf } from "./face.ts";
import { Boundary, Button } from "./ui.tsx";

const duang = (window as unknown as { duang: DuangApi }).duang;

export default function App() {
  const [store] = useState(() => createStore(duang));
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { agents, agentId, states, sessions, conversation: c } = view;
  const agent = agents.find((row) => row.id === agentId);
  const agentState = agentId ? states[agentId] : undefined;
  const busy = view.busy;
  const held = view.loading || (!!agentId && view.changingModel === agentId);
  // Presentation only. `fromPicker`: a connection made there returns to the picker. `reconnect`: a provider's
  // row opens, and a connection returns to the conversation. In one state so every way out drops them.
  const [settings, setSettings] = useState<false | { fromPicker?: true; reconnect?: string; network?: true }>(false);
  const [creating, setCreating] = useState(false);
  const openSettings = () => {
    setCreating(false);
    setSettings((open) => open || {});
  };
  const nextColour = (() => {
    const used = new Set(agents.map((row) => row.colour));
    let colour = 0;
    while (used.has(colour)) colour++;
    return colour;
  })();
  // Mirrors the popover, which owns the fact; it arrives a task later with the `toggle` event.
  const [listOpen, setListOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const rowsFor = (id: string) =>
    rows(
      sessions[id] ?? [],
      id === agentId ? c?.session : undefined,
      view.running[id],
      view.unsent[id],
      view.unseen[id],
    );
  // The row quotes the conversation a click opens; an agent whose selection the runtime has not heard of yet
  // falls back to its newest.
  const latest = (id: string) => {
    const list = rowsFor(id);
    return list.find((row) => row.session === store.sessionFor(id)) ?? list.find((row) => !row.fresh);
  };
  const sessionRows = rowsFor(agentId ?? "");

  useEffect(() => {
    // Main opens the page with `#fresh` after repeated crashes; read once, so ⌘R later reopens as usual.
    const fresh = window.location.hash === "#fresh";
    if (fresh) history.replaceState(null, "", window.location.pathname + window.location.search);
    void store.load({ fresh });
    return store.dispose;
  }, [store]);
  useEffect(() => duang.onOpenSettings(openSettings), []);
  const newConversation = useCallback(() => {
    void store.newConversation().then((opened) => {
      const current = store.getSnapshot();
      // Match the conversation it opened so a late open cannot steal another conversation's focus.
      if (opened && current.conversation === opened && !current.blocked)
        document.querySelector<HTMLTextAreaElement>('main textarea[aria-label="Message"]')?.focus();
    });
  }, [store]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key === "n" && agentState === "ready" && !held) {
        event.preventDefault();
        setSettings(false);
        setCreating(false);
        newConversation();
      }
      // Escape leaves Settings or Create agent first: stopping work you cannot see is a surprise.
      if (event.key === "Escape" && (settings || creating)) {
        setSettings(false);
        setCreating(false);
        return;
      }
      // Asked of the popover, not `listOpen`: an Escape right after it opens arrives before that mirror and would stop the run.
      const listShowing = document.getElementById("conversations")?.matches(":popover-open");
      if (event.key === "Escape" && busy && !listShowing) void store.abort();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newConversation, store, agentState, busy, held, settings, creating]);

  // The floating composer grows with the draft and messages must end above it. A stable ref, or every streamed
  // delta would rebuild the observer.
  const [composerHeight, setComposerHeight] = useState(96);
  const observer = useRef<ResizeObserver>(undefined);
  const composerBox = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!el) return;
    observer.current = new ResizeObserver(([entry]) => setComposerHeight(entry!.contentRect.height));
    observer.current.observe(el);
  }, []);

  const unseenCount = Object.values(view.unseen).reduce((sum, byAgent) => sum + Object.keys(byAgent).length, 0);
  useEffect(() => {
    void duang.setUnseenCount(unseenCount);
  }, [unseenCount]);

  const remove = () => {
    if (confirm("Remove this agent and move its directory to the Trash? The folders it works on are not touched."))
      void store.removeAgent();
  };
  const composer = (
    <Composer
      view={view}
      store={store}
      onProviders={() => setSettings({ fromPicker: true })}
    />
  );
  const waiting = c ? queueView(c.waiting) : [];
  const { pane, alert } = view;
  // A new conversation's composer sits where its transcript's will, so the first send does not move it.
  const reading = pane === "settling" || pane === "transcript" || pane === "start";
  // The conversation's own model's provider, which may differ from the agent default.
  const model = c?.state?.model ?? view.model;
  const provider = model && providerOf(model);
  useEffect(() => {
    if (provider) void store.loadUsage(provider);
  }, [provider, busy, c?.session, store]);
  const last = c?.items.at(-1);
  const signInProblem = last?.kind === "note" && last.fix === "providers";
  useEffect(() => {
    if (signInProblem && !view.providers) void store.loadProviders();
  }, [signInProblem, store]);
  const providerName = provider && (view.providers?.find((row) => row.id === provider)?.name ?? provider);

  return (
    // Floating panels with a gap make the sidebar read as its own surface.
    <AvatarStyleContext.Provider value={view.avatar}>
      <div className="flex h-full gap-2 p-2">
        <Sidebar
          agents={agents}
          agentId={agentId}
          states={states}
          running={view.running}
          doing={view.doing}
          unseen={view.unseen}
          previews={view.previews}
          latest={latest}
          errors={view.sessionsError}
          settingsOpen={Boolean(settings)}
          creatingOpen={creating}
          onSelect={(id) => {
            setSettings(false);
            setCreating(false);
            if (id !== agentId) void store.selectAgent(id);
          }}
          onAdd={() => {
            setSettings(false);
            setCreating(true);
          }}
          onSettings={openSettings}
          onRename={(id, name) => void store.renameAgent(id, name)}
          onReveal={(id) => void store.reveal(id)}
          onMenu={duang.menu}
        />
        <main className="relative flex-1 flex flex-col min-w-0 min-h-0">
          {/* Floating over the pane, so nothing below moves when one comes or goes (docs/ui.md §9b). */}
          {(view.draftsError || (!settings && !creating && (view.failure || alert || c?.ended))) && (
            <div className="pointer-events-none absolute inset-x-0 top-20 z-[7] px-6">
              <div className="column space-y-2">
                {view.draftsError && (
                  <Problem
                    layout="strip"
                    tone="warning"
                    title="Draft storage needs attention"
                    advice="Keep a copy of your unsent text before closing or reloading this window."
                    reason={view.draftsError}
                  />
                )}
                {!settings && !creating && view.failure && (
                  <Problem
                    layout="strip"
                    tone="error"
                    title={view.failure.title}
                    reason={view.failure.reason}
                    onDismiss={store.dismissFailure}
                  />
                )}
                {!settings && !creating && (alert ? (
                  <Problem
                    layout="strip"
                    tone="error"
                    title={alert.title}
                    advice={alert.advice}
                    reason={alert.reason}
                    actions={
                      <Button kind="secondary" size={28} icon={<ArrowClockwise size={12} />} onClick={() => void store.retry()}>
                        Reconnect
                      </Button>
                    }
                  />
                ) : (
                  // An ended subscription is not a failure: the conversation is intact, this view stopped
                  // listening. Said in the calm voice, with the one action that fixes it.
                  c?.ended && (
                    <Problem
                      layout="strip"
                      tone="info"
                      title="This conversation stopped updating"
                      advice="Nothing was lost. Reconnect to follow it again."
                      reason={c.ended}
                      actions={
                        <Button kind="secondary" size={28} icon={<ArrowClockwise size={12} />} onClick={() => void store.retry()}>
                          Reconnect
                        </Button>
                      }
                    />
                  )
                ))}
              </div>
            </div>
          )}
          {settings ? (
            <Settings
              view={view}
              store={store}
              connectOnOpen={settings.fromPicker}
              reconnect={settings.reconnect}
              network={settings.network}
              onConnected={() => {
                if (settings.reconnect) return setSettings(false);
                if (!settings.fromPicker) return;
                store.openPicker();
                setSettings(false);
              }}
              onMenu={duang.menu}
              onClose={() => setSettings(false)}
            />
          ) : creating ? (
            <CreateAgent
              colour={nextColour}
              onPickFolder={() => store.pickFolder()}
              onCreate={async (name, folders) => {
                const refusal = await store.createAgent(name, folders);
                if (!refusal) setCreating(false);
                return refusal;
              }}
              onCancel={() => setCreating(false)}
            />
          ) : (
            <>
              {agent && (
                <ConversationHeader
                  id={agent.id}
                  agent={agent.name}
                  colour={agent.colour}
                  face={faceOf({
                    state: agentState ?? "ready",
                    doing: view.doing[agent.id],
                    outcomes: Object.values(view.unseen[agent.id] ?? {}),
                    open: false,
                  })}
                  dir={agent.dir}
                  content={view.content[agent.id]}
                  working={view.busy}
                  others={(() => {
                    const others = (view.running[agent.id] ?? []).filter((session) => session !== c?.session);
                    if (!others.length) return undefined;
                    return { count: others.length, open: others.length === 1 ? () => void store.open(others[0]!) : undefined };
                  })()}
                  context={
                    c && model && contextUsed(c) !== undefined && view.contextWindows[model]
                      ? { used: contextUsed(c)!, window: view.contextWindows[model]! }
                      : undefined
                  }
                  plan={provider ? view.usage[provider] : undefined}
                  queued={c ? waiting.filter(({ listed }) => listed).length : undefined}
                  details={
                    agentState === "ready" || agentState === "broken"
                      ? { open: detailsOpen, onToggle: () => setDetailsOpen((open) => !open) }
                      : undefined
                  }
                  list={
                    agentState === "ready"
                      ? { open: listOpen, unseen: Object.keys(view.unseen[agent.id] ?? {}).length }
                      : undefined
                  }
                  onReveal={() => void store.reveal()}
                  onRevealPath={(path) => void store.reveal(agent.id, path)}
                  onUsagePage={(provider) => void store.openUsagePage(provider)}
                />
              )}
              {agent && agentState === "ready" && (
                <ConversationList
                  rows={sessionRows}
                  session={c?.session}
                  error={view.sessionsError[agent.id]}
                  disabled={held}
                  onToggle={setListOpen}
                  onOpen={(session) => void store.open(session)}
                  onNew={newConversation}
                />
              )}
              {pane === "unreadable-registry" ? (
                // Not an empty registry: "create your first agent" would deny the failure.
                <UnreadableRegistry reason={view.registryError} onReveal={() => void store.reveal()} onRetry={() => void store.retry()} />
              ) : pane === "no-agents" ? (
                <NoAgents onCreate={() => setCreating(true)} />
              ) : pane === "broken" ? (
                <BrokenAgent
                  message={view.error ?? ""}
                  inConfig={view.errorInConfig}
                  onFreshConfig={() => void store.resetConfig()}
                  onRemove={remove}
                  onReveal={() => void store.reveal()}
                  onRetry={() => void store.retry()}
                />
              ) : pane === "missing-dir" ? (
                <MissingFolder
                  dir={agent?.dir ?? ""}
                  onRemove={remove}
                  onRetry={() => void store.retry()}
                />
              ) : pane === "settling" ? (
                <div className="flex-1 min-h-0" aria-busy="true" />
              ) : pane === "start" || !c /* never both "transcript" and no conversation */ ? (
                <NewConversation />
              ) : (
                // The transcript is pinned to its bottom while streaming, so this gap is where the newest line lands.
                <Boundary
                  reset={c.subscription}
                  fallback={(error) => (
                    <Problem
                      layout="page"
                      tone="error"
                      title="This conversation could not be displayed"
                      advice="Something in it could not be drawn. Its history is safe: try again to read it afresh, or open another conversation."
                      reason={error.message}
                      actions={
                        <Button kind="primary" size={32} icon={<ArrowClockwise size={14} />} onClick={() => void store.retry()}>
                          Try again
                        </Button>
                      }
                    />
                  )}
                >
                  <Transcript
                    key={c.subscription}
                    items={c.items}
                    waiting={waiting}
                    busy={busy}
                    status={c.state?.status}
                    started={c.started}
                    heard={c.heard}
                    bottomGap={composerHeight + 64}
                    resume={store.scrollOf(c.agentId, c.session)}
                    onRest={(place) => store.rememberScroll(c.agentId, c.session, place)}
                    onUsage={(provider) => void store.openUsagePage(provider)}
                    onSettings={(where) =>
                      setSettings(where === "network" ? { network: true } : where === "providers" && provider ? { reconnect: provider } : {})
                    }
                    onPickModel={store.openPicker}
                    onOpenLink={(url) => void store.openLink(url)}
                    onOpenPath={(path) => void store.reveal(c.agentId, path)}
                    provider={providerName}
                    onRetry={
                      view.resend
                        ? () => {
                            // Sending it again may make the agent repeat what its tools already did.
                            if (
                              !view.resend?.toolsRan ||
                              confirm("That run already used tools. Send the message again? The agent may repeat that work.")
                            )
                              void store.resend();
                          }
                        : undefined
                    }
                  />
                </Boundary>
              )}
              {reading && (
                <>
                  {/* Veiled, not painted over: passing text stays faintly visible rather than cut off (#58, #62). */}
                  <div className="veil pointer-events-none absolute inset-x-0 top-0 z-[5] h-12 [mask-image:linear-gradient(to_bottom,black,transparent)]" />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 px-6 pb-4">
                    <div className="veil absolute inset-x-0 bottom-0 h-28 [mask-image:linear-gradient(to_top,black_50%,transparent)]" />
                    <div ref={composerBox} className="column pointer-events-auto">
                      {composer}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </main>
        {!settings && !creating && detailsOpen && agent && (agentState === "ready" || agentState === "broken") && (
          <AgentInspector
            key={agent.id}
            id={agent.id}
            name={agent.name}
            colour={agent.colour}
            face={faceOf({
              state: agentState,
              doing: view.doing[agent.id],
              outcomes: Object.values(view.unseen[agent.id] ?? {}),
              open: false,
            })}
            dir={agent.dir}
            model={view.model}
            showModel={agentState === "ready"}
            skillBlocked={view.blocked}
            content={view.content[agent.id]}
            commands={view.agentCommands[agent.id]}
            tools={view.tools[agent.id]}
            inspection={view.inspection[agent.id]}
            busy={busy || (view.running[agent.id]?.length ?? 0) > 0}
            loading={view.loading}
            onClose={() => setDetailsOpen(false)}
            onPickFolder={() => store.pickFolder()}
            onAddFolder={(folder) => store.addAgentFolder(folder, agent.id)}
            onRemoveFolder={(name) => store.removeAgentFolder(name, agent.id)}
            onSetSecret={(name, value) => store.setAgentSecret(name, value, agent.id)}
            onRemoveSecret={(name) => store.removeAgentSecret(name, agent.id)}
            onReveal={() => void store.reveal()}
            onRevealPath={(path) => void store.reveal(agent.id, path)}
            onSelectSkill={(skillName) => {
              const prefix = `/skill:${skillName} `;
              const current = c?.draft ?? "";
              store.setDraft(current.startsWith(prefix) ? current : `${prefix}${current.replace(/^\/skill:\S+\s*/, "")}`);
              document.querySelector<HTMLTextAreaElement>('main textarea[aria-label="Message"]')?.focus();
            }}
            onRemove={remove}
          />
        )}
      </div>
    </AvatarStyleContext.Provider>
  );
}
