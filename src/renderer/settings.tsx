import { type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import { ArrowClockwise, Check, X } from "@phosphor-icons/react";
import type { AvatarStyle, KageApi, Network, Route } from "../preload/index.ts";
import { Avatar } from "./avatar.tsx";
import type { Connection } from "./settings-store.ts";
import type { Store, View } from "./store.ts";
import { Button } from "./ui.tsx";
import { ProvidersSection } from "./providers.tsx";
import { KINDS, manualFields, manualUrl, type Scheme } from "./network.ts";

const MAC = typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");

export function Settings({
  view,
  store,
  connectOnOpen,
  reconnect,
  network,
  onConnected,
  onMenu,
  onClose,
}: {
  view: View;
  store: Store;
  connectOnOpen?: boolean;
  reconnect?: string;
  network?: boolean;
  onConnected: () => void;
  onMenu: KageApi["menu"];
  onClose: () => void;
}) {
  const saved = view.settings;
  const [mode, setMode] = useState<Network["mode"]>("automatic");
  const [scheme, setScheme] = useState<Scheme>("http");
  const [server, setServer] = useState("");
  const [port, setPort] = useState("");
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    if (network && saved) document.getElementById("network-heading")?.scrollIntoView({ block: "start" });
  }, [network, !!saved]);

  const load = async () => {
    const settings = await store.loadSettings();
    if (!settings) return;
    setMode(settings.network.mode);
    if (settings.network.mode === "manual") {
      const fields = manualFields(settings.network.url);
      setScheme(fields.scheme);
      setServer(fields.server);
      setPort(fields.port);
    }
  };
  // Layout effect: the read first clears the last visit's state, which would otherwise flash for a frame.
  useLayoutEffect(() => {
    void load();
  }, []);

  const apply = async (network: Network) => {
    setProblem(undefined);
    const failed = await store.setNetwork(network);
    if (failed) setProblem(failed);
  };
  const choose = (next: Network["mode"]) => {
    setMode(next);
    setProblem(undefined);
    // Manual is complete only once it has a proxy; a saved one is reused as it was.
    if (next !== "manual") void apply({ mode: next });
    else if (saved?.network.mode === "manual") void apply(saved.network);
  };
  const saveManual = () => {
    const result = manualUrl(scheme, server, port);
    if ("error" in result) setProblem(result.error);
    else void apply({ mode: "manual", url: result.url });
  };

  const current = saved?.network.mode;
  const savedManual = saved?.network.mode === "manual" ? saved.network.url : undefined;
  const state = (option: Network["mode"]) =>
    option === current && saved ? (
      <Status route={saved.route} check={view.connection} onRefresh={() => void store.checkConnection()} />
    ) : undefined;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-[600px] px-6 pt-6 pb-10">
        <div className="flex items-center gap-2 mb-6">
          <h1 className="flex-1 text-[22px] font-medium drag">Settings</h1>
          <Button kind="ghost" size={28} onClick={onClose} aria-label="Close settings" title="Close (Esc)" icon={<X size={14} />} />
        </div>

        <div className="space-y-6">
          <ProvidersSection
            view={view}
            store={store}
            onMenu={onMenu}
            focusAdd={connectOnOpen}
            reconnect={reconnect}
            onConnected={onConnected}
          />
          {view.settingsError ? (
            <div role="alert" className="space-y-3">
              <p className="text-danger whitespace-pre-wrap break-words">{view.settingsError}</p>
              <p className="text-muted text-[12px]">
                Fix or remove the file, then retry. Until then the network follows the system proxy.
              </p>
              <div className="flex gap-2">
                <Button onClick={() => void store.revealSettings()}>Reveal in Finder</Button>
                <Button kind="ghost" onClick={() => void load()}>
                  Retry
                </Button>
              </div>
            </div>
          ) : !saved ? (
            <p role="status" className="text-muted">
              Loading…
            </p>
          ) : (
            <div className="space-y-6">
              <Group
                id="network-heading"
                title="Network"
              >
                <RadioGroup label="Proxy">
                  <Option label="Automatic" checked={mode === "automatic"} onSelect={() => choose("automatic")}>
                    {state("automatic") ?? `Follow ${MAC ? "macOS" : "system"} proxy settings, including a VPN switched on later`}
                  </Option>
                  <Option label="Manual" checked={mode === "manual"} onSelect={() => choose("manual")}>
                    {state("manual") ?? savedManual ?? "Not set"}
                  </Option>
                  <Option label="Off" checked={mode === "off"} onSelect={() => choose("off")}>
                    {state("off") ?? "Connect directly"}
                  </Option>
                </RadioGroup>
              </Group>

              {mode === "manual" && (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveManual();
                  }}
                >
                  <Group title="Manual proxy">
                    <RadioGroup label="Proxy type">
                      {KINDS.map((kind) => (
                        <Option key={kind.scheme} label={kind.label} checked={scheme === kind.scheme} onSelect={() => setScheme(kind.scheme)} />
                      ))}
                    </RadioGroup>
                  </Group>
                  <Group>
                    <Field label="Server" value={server} onChange={setServer} placeholder="127.0.0.1" />
                    <Field label="Port" value={port} onChange={setPort} placeholder="7890" inputMode="numeric" />
                  </Group>
                  <div className="flex items-start gap-3 px-4">
                    <p role="alert" className="flex-1 text-[12px] text-danger">
                      {problem}
                    </p>
                    {/* Keeps Enter working in either field; Button forces type="button". */}
                    <button type="submit" hidden />
                    <Button kind="primary" onClick={saveManual}>
                      Use this proxy
                    </Button>
                  </div>
                </form>
              )}
              {saved.route.commandError && (
                <p role="alert" className="px-4 text-danger text-[12px]">
                  {saved.route.commandError}
                </p>
              )}
              {mode !== "manual" && problem && (
                <p role="alert" className="px-4 text-danger text-[12px]">
                  {problem}
                </p>
              )}
              <Appearance view={view} store={store} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const STYLES: Record<AvatarStyle, { label: string; note: string }> = {
  gaze: { label: "Gaze", note: "Shapes with eyes that follow the work" },
  moods: { label: "Moods", note: "Round faces" },
  clay: { label: "Clay", note: "Little clay figures" },
  bottts: { label: "Bottts", note: "Robots, drawn by Pablo Stanley" },
  pixelbot: { label: "Pixelbot", note: "Pixel robots" },
  initialFace: { label: "Initial face", note: "A face wearing the name's first letter" },
  initials: { label: "Initials", note: "The name's first two letters" },
};
const SAMPLES = ["research", "ops-bot", "writer", "旅行助手"];

function Appearance({ view, store }: { view: View; store: Store }) {
  const [problem, setProblem] = useState<string>();
  return (
    <Group id="appearance-heading" title="Avatars">
      <RadioGroup label="Avatar style">
        {(Object.keys(STYLES) as AvatarStyle[]).map((style) => (
          <Option
            key={style}
            label={STYLES[style].label}
            checked={view.avatar === style}
            onSelect={() => {
              setProblem(undefined);
              void store.setAvatar(style).then(setProblem);
            }}
          >
            <span className="mt-1.5 flex items-center gap-2">
              {SAMPLES.map((name, colour) => (
                <Avatar key={name} id={`sample-${name}`} name={name} colour={colour} size={26} style={style} />
              ))}
              <span className="ml-1">{STYLES[style].note}</span>
            </span>
          </Option>
        ))}
      </RadioGroup>
      {problem && (
        <p role="alert" className="px-4 py-2 text-danger text-[12px]">
          {problem}
        </p>
      )}
    </Group>
  );
}

export function Group({ id, title, children }: { id?: string; title?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-1.5">
      {title && (
        <h2 id={id} className="px-4 text-[12px] font-medium text-muted">
          {title}
        </h2>
      )}
      <div className="overflow-hidden rounded-float bg-surface ring-1 ring-stroke">{children}</div>
    </section>
  );
}

export const row =
  "relative before:absolute before:left-4 before:right-0 before:top-0 before:h-px before:bg-stroke first:before:hidden";

// The radio group's keyboard contract (§11): one tab stop on the checked row, arrows move the choice.
function RadioGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) => {
        const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
        if (!step) return;
        const radios = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
        const at = radios.indexOf(document.activeElement as HTMLElement);
        if (at < 0) return;
        event.preventDefault();
        const next = radios[(at + step + radios.length) % radios.length]!;
        next.focus();
        next.click();
      }}
    >
      {children}
    </div>
  );
}

function Option({
  label,
  checked,
  onSelect,
  children,
}: {
  label: string;
  checked: boolean;
  onSelect: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      role="radio"
      aria-checked={checked}
      tabIndex={checked ? 0 : -1}
      onClick={onSelect}
      onKeyDown={(event) => {
        // Only the row's own keys: Enter on the refresh control inside it must refresh, not re-apply.
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={`${row} flex cursor-pointer items-center gap-3 px-4 py-2.5 outline-none hover:bg-hover focus-visible:bg-hover`}
    >
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {children && <span className="block text-[12px] text-muted">{children}</span>}
      </span>
      {checked && <Check size={16} weight="bold" className="shrink-0 text-accent" aria-hidden />}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  inputMode?: "numeric";
}) {
  return (
    <label className={`${row} flex items-center gap-3 px-4 py-2.5`}>
      <span className="w-16 shrink-0">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        placeholder={placeholder}
        inputMode={inputMode}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-muted"
      />
    </label>
  );
}

function Status({ route, check, onRefresh }: { route: Route; check?: Connection; onRefresh: () => void }) {
  const result = !check
    ? null
    : "checking" in check
      ? <span>checking…</span>
      : "error" in check
        ? (
            <span className="text-danger" title={check.error}>
              unreachable{check.code ? ` (${check.code})` : ""}
            </span>
          )
        : <span className="text-accent" title={`api.anthropic.com answered HTTP ${check.status}`}>connected · {check.ms} ms</span>;
  return (
    <span data-source={route.source} className="flex flex-wrap items-center gap-x-1.5">
      {route.error ? (
        // The system answered with a route kage cannot take; model requests fail with this reason.
        <span className="text-danger" title={route.error}>
          unsupported proxy route
        </span>
      ) : (
        // Only the surprise is named: a terminal launch's variable wins over the system until a normal launch.
        <span className="font-mono">
          {route.proxy ?? "Direct"}
          {route.source === "environment" && (
            <span
              className="font-sans"
              title={`kage was started from a terminal with ${route.variable ?? "a proxy variable"} set. Open kage from the Dock to follow ${MAC ? "macOS" : "system"} settings.`}
            >
              {" "}
              from {route.variable ?? "the launch environment"}
            </span>
          )}
        </span>
      )}
      {result && <span aria-hidden>·</span>}
      <span role="status">{result}</span>
      <button
        type="button"
        onClick={(event) => {
          // The row itself is the choice; refreshing must not re-apply it.
          event.stopPropagation();
          onRefresh();
        }}
        aria-label="Check the connection again"
        title="Check again"
        className="rounded-card p-0.5 text-muted hover:text-text hover:bg-hover"
      >
        <ArrowClockwise size={12} aria-hidden />
      </button>
    </span>
  );
}
