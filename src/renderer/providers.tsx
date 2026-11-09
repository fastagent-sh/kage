// No dialog: the page stays the context. The sign-in is drawn by what it asks for, never per provider.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CaretDown, CaretRight, Check, Copy, DotsThree, Globe, Key, MagnifyingGlass, X } from "@phosphor-icons/react";
import type { KageApi, ProviderRow } from "../preload/index.ts";
import { keyStep, type SignIn } from "./settings-store.ts";
import type { Store, View } from "./store.ts";
import { PlanUsage } from "./plan-usage.tsx";
import { Group, row } from "./settings.tsx";
import { Badge, Button, useCopy } from "./ui.tsx";

type Way = ProviderRow["ways"][number];

const COMMON = ["anthropic", "openai", "github-copilot", "google", "xai", "deepseek", "openrouter"];

// LobeHub's static SVGs, vendored with their license (provider-logos/LICENSE).
const svgs = import.meta.glob<string>("./provider-logos/*.svg", { eager: true, query: "?raw", import: "default" });
const LOGOS: Record<string, string> = {
  "amazon-bedrock": "bedrock-color", "ant-ling": "antgroup-color", anthropic: "anthropic",
  "azure-openai-responses": "azure-color", baseten: "baseten", cerebras: "cerebras-color",
  "cloudflare-ai-gateway": "cloudflare-color", "cloudflare-workers-ai": "cloudflare-color",
  deepseek: "deepseek-color", fireworks: "fireworks-color", "github-copilot": "githubcopilot",
  google: "gemini-color", "google-vertex": "vertexai-color", groq: "groq", huggingface: "huggingface-color",
  "kimi-coding": "kimi-color", meta: "meta-color", minimax: "minimax-color", "minimax-cn": "minimax-color",
  mistral: "mistral-color", moonshotai: "moonshot", "moonshotai-cn": "moonshot", nvidia: "nvidia-color",
  openai: "openai", opencode: "opencode", "opencode-go": "opencode",
  openrouter: "openrouter", "qwen-token-plan": "qwen-color", "qwen-token-plan-cn": "qwen-color",
  "qwen-token-plan-individual": "qwen-color", together: "together-color", "vercel-ai-gateway": "vercel",
  xai: "xai", xiaomi: "xiaomimimo", "xiaomi-token-plan-ams": "xiaomimimo", "xiaomi-token-plan-cn": "xiaomimimo",
  "xiaomi-token-plan-sgp": "xiaomimimo", zai: "zai", "zai-coding-cn": "zai",
};

function ProviderMark({ provider, size = 32 }: { provider: ProviderRow; size?: number }) {
  const svg = svgs[`./provider-logos/${LOGOS[provider.id]}.svg`];
  const tile = "grid shrink-0 place-items-center rounded-card bg-bg text-text ring-1 ring-stroke";
  if (!svg)
    return (
      <span aria-hidden className={`${tile} font-semibold text-muted`} style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}>
        {provider.name.slice(0, 2)}
      </span>
    );
  return (
    <span
      aria-hidden
      // A vendored, static file from this repository: nothing in it comes from a provider or a person.
      dangerouslySetInnerHTML={{ __html: svg }}
      className={tile}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.56) }}
    />
  );
}

const methodName = (method: Way["method"]) => (method === "oauth" ? "subscription login" : "API key");

function sources(provider: ProviderRow): string {
  const held =
    provider.stored === "oauth"
      ? [plan(provider.ways.find((way) => way.method === "oauth")) ?? "Subscription"]
      : provider.stored === "api_key"
        ? ["API key"]
        : [];
  return [...held, ...(provider.ambient ? [`from ${provider.ambient}`] : [])].join(" · ");
}

function plan(way: Way | undefined): string | undefined {
  return way ? /\(([^)]+)\)\s*$/.exec(way.label)?.[1] ?? undefined : undefined;
}

function wayTitle(way: Way): string {
  if (way.method === "api_key") return "API key";
  return plan(way) ?? (way.subscription ? "Subscription" : "Sign in");
}

function wayBlurb(way: Way): string {
  if (way.method === "api_key") return "Pay as you go";
  return way.subscription ? "Sign in with your plan" : "Sign in in your browser";
}

export function ProvidersSection({
  view,
  store,
  onMenu,
  focusAdd,
  reconnect,
  onConnected,
}: {
  view: View;
  store: Store;
  onMenu: KageApi["menu"];
  focusAdd?: boolean;
  reconnect?: string;
  onConnected: () => void;
}) {
  const [open, setOpen] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [landed, setLanded] = useState<{ id: string; unchecked: boolean }>();
  const [more, setMore] = useState(false);
  const [filter, setFilter] = useState("");
  const addCard = useRef<HTMLDivElement>(null);
  const signIn = view.signIn;

  useEffect(() => {
    void store.loadProviders();
    // Leaving Settings (⌘N reaches the window) must not leave a sign-in running where nobody sees it.
    return () => {
      if (store.getSnapshot().signIn) void store.closeSignIn();
    };
  }, [store]);
  // Main keeps one answer per login for a few minutes, so opening Settings does not poll.
  const subscriptions = (view.providers ?? []).filter((p) => p.stored === "oauth").map((p) => p.id).join();
  useEffect(() => {
    for (const id of subscriptions ? subscriptions.split(",") : []) void store.loadUsage(id);
  }, [subscriptions, store]);
  useEffect(() => {
    if (focusAdd && view.providers) addCard.current?.scrollIntoView({ block: "start" });
  }, [focusAdd, view.providers !== undefined]);
  useEffect(() => {
    if (!reconnect || !view.providers?.some((p) => p.id === reconnect)) return;
    show(reconnect);
    requestAnimationFrame(() => document.querySelector(`[data-provider="${reconnect}"]`)?.scrollIntoView({ block: "center" }));
  }, [reconnect, view.providers !== undefined]);
  useEffect(() => {
    if (!signIn?.outcome?.ok) return;
    setLanded({ id: signIn.provider.id, unchecked: signIn.outcome.verified === "unknown" });
    // It moves to the list above, which may be scrolled away: follow it there.
    const id = signIn.provider.id;
    requestAnimationFrame(() =>
      document.querySelector(`#providers-heading ~ div [data-provider="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
    setOpen(undefined);
    void store.closeSignIn();
    // A new login is a new plan: main forgot the old one's usage, and so must the row.
    void store.loadUsage(id);
    onConnected();
  }, [signIn?.outcome]);
  useEffect(() => {
    if (!landed) return;
    const timer = setTimeout(() => setLanded(undefined), landed.unchecked ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [landed]);

  // Closing a row ends what it was doing, and opening another closes it, so nothing is ever locked.
  const show = (id?: string) => {
    if (store.getSnapshot().signIn) void store.closeSignIn();
    setConfirming(undefined);
    setOpen(id);
  };
  const toggle = (id: string) => show(open === id ? undefined : id);
  const menu = async (provider: ProviderRow) => {
    const chosen = await onMenu(
      provider.stored
        ? [
            { id: "reconnect", label: "Reconnect…" },
            { id: "disconnect", label: "Disconnect" },
          ]
        : [{ id: "reconnect", label: "Connect…" }],
    );
    if (chosen === "reconnect") toggle(provider.id);
    if (chosen === "disconnect") {
      show(undefined);
      setConfirming(provider.id);
    }
  };

  const providers = view.providers ?? [];
  const connected = providers.filter((p) => p.stored || p.ambient);
  const addable = providers.filter((p) => !p.stored && !p.ambient);
  const common = COMMON.flatMap((id) => addable.filter((p) => p.id === id));
  const rest = addable.filter((p) => !COMMON.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  const needle = filter.trim().toLowerCase();
  const found = needle ? addable.filter((p) => `${p.name} ${p.id}`.toLowerCase().includes(needle)) : undefined;

  const rowProps = (provider: ProviderRow) => ({
    provider,
    store,
    signIn: signIn?.provider.id === provider.id ? signIn : undefined,
    open: open === provider.id,
    onToggle: () => toggle(provider.id),
  });

  if (view.providersError)
    return (
      <Group id="providers-heading" title="Model providers">
        <div role="alert" className="space-y-2 px-4 py-3">
          <p className="text-danger whitespace-pre-wrap break-words">{view.providersError}</p>
          <div className="flex gap-2">
            <Button size={28} onClick={() => void store.revealProviders()}>
              Reveal in Finder
            </Button>
            <Button kind="ghost" size={28} onClick={() => void store.loadProviders()}>
              Retry
            </Button>
          </div>
        </div>
      </Group>
    );
  if (!view.providers)
    return (
      <Group id="providers-heading" title="Model providers">
        <p role="status" className="px-4 py-3 text-muted">
          Loading…
        </p>
      </Group>
    );

  return (
    <div className="space-y-6">
      <Group id="providers-heading" title="Model providers">
        {connected.length === 0 ? (
          <div className="px-4 py-3.5">
            <p>Connect a model to start working.</p>
            <p className="text-[12px] text-muted">Sign in with a plan you already pay for, or use an API key.</p>
          </div>
        ) : (
          connected.map((provider) =>
            confirming === provider.id ? (
              <ConfirmDisconnect
                key={provider.id}
                provider={provider}
                onCancel={() => setConfirming(undefined)}
                onConfirm={() => {
                  setConfirming(undefined);
                  void store.disconnect(provider.id);
                }}
              />
            ) : (
              <ProviderItem
                key={provider.id}
                {...rowProps(provider)}
                detail={sources(provider)}
                // A connected row's own click would be one misclick from a reconnect.
                header={{
                  trailing: (
                    <>
                      {provider.stored === "oauth" && <PlanUsage plan={view.usage[provider.id]} onPage={(id) => void store.openUsagePage(id)} />}
                      {landed?.id === provider.id && (
                        <Badge tone={landed.unchecked ? "warning" : "success"} className="enter">
                          {landed.unchecked ? "saved · key not checked" : "connected"}
                        </Badge>
                      )}
                      <Button
                        kind="ghost"
                        size={28}
                        aria-label={`Actions for ${provider.name}`}
                        title="Actions"
                        onClick={() => void menu(provider)}
                        icon={<DotsThree size={16} weight="bold" />}
                      />
                    </>
                  ),
                  togglable: false,
                }}
              />
            ),
          )
        )}
      </Group>

      <div ref={addCard}>
        <Group id="providers-add-heading" title="Add a provider">
          <label className={`${row} flex items-center gap-3 px-4 py-2`}>
            <span className="grid w-8 place-items-center text-muted">
              <MagnifyingGlass size={14} />
            </span>
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                // A query is cleared first; only an empty field lets Escape leave Settings.
                if (event.key === "Escape" && filter) {
                  event.preventDefault();
                  setFilter("");
                }
              }}
              aria-label="Filter providers"
              placeholder="Search providers"
              className="h-7 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
            />
            {filter && (
              <Button kind="ghost" size={28} aria-label="Clear search" title="Clear" onClick={() => setFilter("")} icon={<X size={13} />} />
            )}
          </label>
          {(found ?? common).map((provider) => (
            <ProviderItem key={provider.id} {...rowProps(provider)} detail={offers(provider)} />
          ))}
          {found && found.length === 0 && <p className={`${row} px-4 py-3 text-muted`}>Nothing matches “{filter}”.</p>}
          {more && !found && rest.map((provider) => <ProviderItem key={provider.id} {...rowProps(provider)} detail={offers(provider)} />)}
          {!found && rest.length > 0 && (
            <button
              type="button"
              aria-expanded={more}
              onClick={() => setMore(!more)}
              className={`${row} flex w-full items-center gap-3 px-4 py-2.5 text-left text-muted hover:bg-hover`}
            >
              <span className="grid w-8 place-items-center">
                <CaretDown size={13} className={`transition-transform ${more ? "rotate-180" : ""}`} />
              </span>
              <span className="flex-1">{more ? "Show fewer" : "More providers"}</span>
              {!more && <span className="text-[12px] tabular-nums">{rest.length}</span>}
            </button>
          )}
        </Group>
      </div>
    </div>
  );
}

function offers(provider: ProviderRow): string {
  return provider.ways.map(wayTitle).join(" · ");
}

function ProviderItem({
  provider,
  store,
  signIn,
  open,
  detail,
  header,
  onToggle,
}: {
  provider: ProviderRow;
  store: Store;
  signIn?: SignIn;
  open: boolean;
  detail: string;
  header?: { trailing: ReactNode; togglable: false };
  onToggle: () => void;
}) {
  const signingIn = signIn && !signIn.outcome ? plan(signIn.way) : undefined;
  const doing =
    signIn && !signIn.outcome
      ? signIn.way.method === "api_key"
        ? "Adding an API key"
        : signingIn
          ? `Signing in with ${signingIn}`
          : "Signing in"
      : undefined;
  const title = (
    <>
      <ProviderMark provider={provider} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{provider.name}</span>
        <span className="block truncate text-[12px] text-muted">{doing ?? detail}</span>
      </span>
    </>
  );
  return (
    <div data-provider={provider.id} className={`${row} ${open ? "bg-hover" : ""}`}>
      {/* Open, a row closes by its header, which also cancels a sign-in: no second Cancel. */}
      {header && !open ? (
        <div className="flex items-center gap-3 px-4 py-2.5">
          {title}
          {header.trailing}
        </div>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left ${open ? "" : "hover:bg-hover"}`}
        >
          {title}
          <CaretRight size={13} className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
      )}
      {open && (
        <div className="enter px-4 pt-1 pb-3.5 pl-[60px]">
          {signIn ? (
            <Flow signIn={signIn} store={store} />
          ) : (
            <Ways provider={provider} onChoose={(way) => void store.connect(provider, way)} />
          )}
        </div>
      )}
    </div>
  );
}

function Ways({ provider, onChoose }: { provider: ProviderRow; onChoose: (way: Way) => void }) {
  return (
    <div className="space-y-2">
      <div className={`grid gap-2 ${provider.ways.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
        {provider.ways.map((way) => (
          <button
            key={way.method}
            type="button"
            onClick={() => onChoose(way)}
            className="flex min-w-0 items-center gap-2.5 rounded-card bg-surface px-3 py-2 text-left ring-1 ring-stroke outline-none transition-shadow hover:ring-accent/60 focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-card bg-accent-weak text-accent" aria-hidden>
              {way.method === "api_key" ? <Key size={15} /> : <Globe size={15} />}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-medium">{wayTitle(way)}</span>
              <span className="block truncate text-[12px] text-muted">{wayBlurb(way)}</span>
            </span>
          </button>
        ))}
      </div>
      {provider.stored && (
        // One credential per provider in the file.
        <p className="text-[12px] text-muted">Connecting replaces the {methodName(provider.stored)} saved now.</p>
      )}
    </div>
  );
}

function ConfirmDisconnect({ provider, onCancel, onConfirm }: { provider: ProviderRow; onCancel: () => void; onConfirm: () => void }) {
  const reach = provider.ambient
    ? `Requests will continue with ${provider.ambient}.`
    : "Conversations using it stop working until it is connected again.";
  return (
    <div data-provider={provider.id} role="alertdialog" aria-label={`Disconnect ${provider.name}`} className={`${row} flex items-center gap-3 px-4 py-2.5`}>
      <ProviderMark provider={provider} />
      <span className="min-w-0 flex-1">
        <span className="block">Disconnect {provider.name}?</span>
        <span className="block text-[12px] text-muted">{reach}</span>
      </span>
      <Button kind="ghost" size={28} onClick={onCancel} autoFocus>
        Cancel
      </Button>
      <Button kind="danger" loud size={28} onClick={onConfirm}>
        Disconnect
      </Button>
    </div>
  );
}

function FlowInfo({ info, store, className = "" }: { info: NonNullable<SignIn["info"]>; store: Store; className?: string }) {
  return (
    <div className={`space-y-1 text-[12px] text-muted ${className}`}>
      <p className="whitespace-pre-wrap break-words">{info.message}</p>
      {info.links?.map((link) => (
        <button key={link.url} type="button" className="block text-accent underline" onClick={() => void store.openLoginUrl(link.url)}>
          {link.label}
        </button>
      ))}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { copied, failed, copy } = useCopy(text);
  return (
    <Button
      kind="ghost"
      size={28}
      onClick={copy}
      title={failed ? `Could not copy: ${failed}` : undefined}
      icon={copied ? <Check size={13} /> : <Copy size={13} />}
    >
      {failed ? "Not copied" : copied ? "Copied" : label}
    </Button>
  );
}

// The flow's own words are written for a terminal; the row says its states in its own words and keeps the
// flow's text only where it is a reason or a link (docs/ui.md §9).
function Flow({ signIn, store }: { signIn: SignIn; store: Store }) {
  const { url, device, info, prompt, outcome, provider } = signIn;
  if (outcome && !outcome.ok)
    return (
      <div role="alert" className="space-y-2.5">
        <Status tone="danger" title="Couldn't connect" detail={outcome.error} />
        <div className="flex gap-2 pl-6">
          <Button size={28} onClick={() => void store.connect(signIn.provider, signIn.way)}>
            Try again
          </Button>
          <Button kind="ghost" size={28} onClick={() => void store.closeSignIn()}>
            Back
          </Button>
        </div>
      </div>
    );

  if (url)
    return (
      <div className="space-y-3">
        <Status tone="waiting" title="Waiting for you to finish in your browser…" detail={`Sign in at ${new URL(url.url).host}.`} />
        <div className="flex flex-wrap items-center gap-2 pl-6">
          <Button size={28} onClick={() => void store.openLoginUrl(url.url)}>
            Open again
          </Button>
          <CopyButton text={url.url} label="Copy link" />
        </div>
        {info && <FlowInfo info={info} store={store} className="pl-6" />}
        {prompt?.prompt.type === "manual_code" && (
          <details className="group pl-6 text-[12px]">
            <summary className="flex cursor-pointer select-none items-center gap-1 text-muted marker:content-none hover:text-text">
              <CaretRight size={11} className="transition-transform group-open:rotate-90" />
              Browser on another device?
            </summary>
            <div className="mt-2 space-y-2">
              {/* The flow says this twice, for a terminal. Once, in ours. */}
              <p className="text-muted">Finish signing in there, then paste the address the browser ends on, or the code it shows.</p>
              <Answer key={prompt.id} prompt={prompt.prompt} store={store} action="Continue" label="Address or code" labelHidden placeholder="Address or code" />
            </div>
          </details>
        )}
      </div>
    );

  if (device) return <DeviceCode device={device} store={store} />;

  const key = keyStep(signIn);
  if (key) {
    const refused = key === "refused";
    return (
      <div className="space-y-2">
        {refused && (
          <div role="alert" className="space-y-1">
            <Status tone="danger" title={`${provider.name} didn't accept this key`} detail="Check it and paste it again." />
            {info && (
              <details className="group pl-6 text-[12px]">
                <summary className="flex cursor-pointer select-none items-center gap-1 text-muted marker:content-none hover:text-text">
                  <CaretRight size={11} className="transition-transform group-open:rotate-90" />
                  What {provider.name} said
                </summary>
                <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-muted">{info.message}</p>
              </details>
            )}
          </div>
        )}
        <KeyField promptId={prompt?.id} store={store} label={`${provider.name} API key`} />
      </div>
    );
  }

  if (prompt)
    return (
      <div className="space-y-2">
        <Answer key={prompt.id} prompt={prompt.prompt} store={store} action="Continue" />
        {info && <FlowInfo info={info} store={store} />}
      </div>
    );

  // Usually gone before it could be read, hence the delay.
  return (
    <div className="after-a-moment">
      <Status tone="waiting" title={`Connecting to ${provider.name}…`} />
    </div>
  );
}

function Status({ tone, title, detail }: { tone: "waiting" | "danger"; title: string; detail?: string }) {
  return (
    <div role={tone === "danger" ? undefined : "status"} className="grid grid-cols-[16px_1fr] items-baseline gap-x-2">
      <span className="flex h-full items-center justify-center" aria-hidden>
        <span className={`size-1.5 rounded-full ${tone === "danger" ? "bg-danger" : "animate-pulse bg-accent"}`} />
      </span>
      <span className={tone === "danger" ? "text-danger" : "shimmer"}>
        {title}
      </span>
      {detail && <span className="col-start-2 text-[12px] text-muted whitespace-pre-wrap break-words">{detail}</span>}
    </div>
  );
}

function DeviceCode({ device, store }: { device: NonNullable<SignIn["device"]>; store: Store }) {
  const [left, setLeft] = useState(device.expiresInSeconds);
  useEffect(() => {
    if (device.expiresInSeconds === undefined) return;
    const started = Date.now();
    const timer = setInterval(
      () => setLeft(Math.max(0, device.expiresInSeconds! - Math.floor((Date.now() - started) / 1000))),
      1000,
    );
    return () => clearInterval(timer);
  }, [device]);
  const host = new URL(device.verificationUri).host;
  return (
    <div className="space-y-3">
      <Status
        tone="waiting"
        title={`Enter this code at ${host}`}
        detail={left === undefined ? undefined : left > 0 ? `The code expires in ${Math.ceil(left / 60)} min.` : "The code expired. Close this and start again."}
      />
      <div className="flex flex-wrap items-center gap-2 pl-6">
        <span className="rounded-card bg-surface px-3 py-1 font-mono text-[22px] tracking-[0.18em] ring-1 ring-stroke select-all">
          {device.userCode}
        </span>
        <CopyButton text={device.userCode} label="Copy code" />
      </div>
      <div className="pl-6">
        <Button size={28} onClick={() => void store.openLoginUrl(device.verificationUri)}>
          Open {host}
        </Button>
      </div>
    </div>
  );
}

const fieldClass =
  "h-7 min-w-0 flex-1 rounded-card bg-surface px-2.5 outline-none ring-1 ring-stroke placeholder:font-sans placeholder:text-muted focus:ring-accent/60 disabled:opacity-60";

// Shown as typed so a paste can be checked. Lives only as long as the sign-in; drafts never see it.
function KeyField({ promptId, store, label }: { promptId?: string; store: Store; label: string }) {
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const checking = promptId === undefined;
  useEffect(() => {
    if (!checking) input.current?.select();
  }, [promptId, checking]);
  const submit = () => void store.answerSignIn(value.trim());
  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="block text-[12px] text-muted" htmlFor="provider-key">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id="provider-key"
          ref={input}
          autoFocus
          disabled={checking}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Paste your key"
          className={`${fieldClass} font-mono text-[12.5px]`}
        />
        <Button kind="primary" size={28} onClick={submit} disabled={checking ? "Checking the key" : undefined}>
          {checking ? "Checking…" : "Connect"}
        </Button>
      </div>
    </form>
  );
}

function Answer({
  prompt,
  store,
  action,
  label,
  labelHidden,
  placeholder,
}: {
  prompt: NonNullable<SignIn["prompt"]>["prompt"];
  store: Store;
  action: string;
  label?: string;
  labelHidden?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  if (prompt.type === "select")
    return (
      <div className="space-y-1.5">
        <p className="text-[12px] text-muted">{prompt.message}</p>
        <div className="overflow-hidden rounded-card bg-surface ring-1 ring-stroke">
          {prompt.options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => void store.answerSignIn(option.id)}
              className={`${row} flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover`}
            >
              <span className="min-w-0 flex-1">
                <span className="block">{option.label}</span>
                {option.description && <span className="block text-[12px] text-muted">{option.description}</span>}
              </span>
              <CaretRight size={12} className="shrink-0 text-muted" />
            </button>
          ))}
        </div>
      </div>
    );
  const submit = () => {
    void store.answerSignIn(value.trim());
    setValue("");
  };
  const text = label ?? prompt.message;
  const id = `answer-${text}`;
  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className={labelHidden ? "sr-only" : "block text-[12px] text-muted"} htmlFor={id}>
        {text}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label={text}
          placeholder={placeholder ?? prompt.placeholder}
          className={`${fieldClass} font-mono text-[12.5px]`}
        />
        <Button kind="primary" size={28} onClick={submit}>
          {action}
        </Button>
      </div>
    </form>
  );
}
