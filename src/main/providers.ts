// No Electron import, so it runs under `node --test`. The window never receives a credential.
import {
  signIn,
  SignInCancelled,
  signInOptions,
  type CredentialStore,
  type SignInEvent,
  type SignInMethod,
  type SignInPrompt,
} from "@fastagent-sh/fastagent";

export type LoginMethod = SignInMethod;

export interface ProviderRow {
  id: string;
  name: string;
  ways: { method: LoginMethod; label: string; subscription: boolean }[];
  stored?: LoginMethod;
  ambient?: string;
  problem?: string;
}

// pi keeps `openai-codex` only for old logins; Sign in with ChatGPT on `openai` replaced it.
const RETIRED = new Set(["openai-codex"]);
export const retired = (providerOrSpec: string) => RETIRED.has(providerOrSpec.split("/")[0]!);

// `ambient` is what the environment alone would authenticate with: a stored credential hides an env variable
// that keeps answering after a disconnect, and FastAgent reports it apart from `status`.
export async function listProviders(credentials: CredentialStore): Promise<ProviderRow[]> {
  const held = new Map((await credentials.list()).map((info) => [info.provider, info.type]));
  const rows = new Map<string, ProviderRow>();
  for (const option of await signInOptions(credentials)) {
    if (retired(option.provider) || option.external) continue;
    let row = rows.get(option.provider);
    if (!row) {
      const stored = held.get(option.provider);
      row = {
        id: option.provider,
        name: option.name,
        ways: [],
        ...(stored ? { stored } : {}),
        ...(option.environment ? { ambient: option.environment } : {}),
        ...(option.problem ? { problem: option.problem } : {}),
      };
      rows.set(option.provider, row);
    }
    row.ways.push({ method: option.method, label: option.label, subscription: option.subscription });
  }
  return [...rows.values()];
}

export const disconnect = (credentials: CredentialStore, provider: string): Promise<void> => credentials.delete(provider);

// Distributes over the union so each variant keeps its own fields.
type WithoutSignal<T> = T extends unknown ? Omit<T, "signal"> : never;

export type LoginStep =
  | { type: "prompt"; id: string; prompt: WithoutSignal<SignInPrompt> }
  | { type: "dismiss"; id: string }
  | SignInEvent;

export type LoginOutcome =
  | { ok: true; verified: "ok" | "unknown" | "n/a" }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: never; error: string };

// Only `https:`, or `http:` to loopback (an OAuth callback): nothing else may reach `shell.openExternal`.
export function openable(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" || (protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname));
  } catch {
    return false;
  }
}

export function startLogin(options: {
  provider: string;
  method: LoginMethod;
  credentials: CredentialStore;
  send: (step: LoginStep) => void;
  open: (url: string) => Promise<void>;
  run?: typeof signIn;
}) {
  const { provider, method, credentials, send, open, run = signIn } = options;
  const abort = new AbortController();
  const pending = new Map<string, (value: string) => void>();
  const reported = new Set<string>();
  let next = 0;
  const report = (url: string) => {
    if (!openable(url)) return false;
    reported.add(url);
    return true;
  };

  const result: Promise<LoginOutcome> = run({
    provider,
    method,
    credentials,
    interaction: {
      signal: abort.signal,
      prompt(prompt) {
        const { signal, ...shown } = prompt;
        const id = String(++next);
        return new Promise<string>((resolve, reject) => {
          const withdraw = () => {
            pending.delete(id);
            send({ type: "dismiss", id });
            reject(signal?.reason ?? abort.signal.reason ?? new Error("prompt withdrawn"));
          };
          if (signal?.aborted || abort.signal.aborted) return withdraw();
          signal?.addEventListener("abort", withdraw, { once: true });
          abort.signal.addEventListener("abort", withdraw, { once: true });
          pending.set(id, (value) => {
            signal?.removeEventListener("abort", withdraw);
            abort.signal.removeEventListener("abort", withdraw);
            pending.delete(id);
            resolve(value);
          });
          send({ type: "prompt", id, prompt: shown });
        });
      },
      notify(event) {
        // The browser opens by itself for a sign-in; everything else is opened on request. A browser
        // that does not open is said in the sign-in's row, where Copy link is the way on.
        if (event.type === "auth_url" && report(event.url))
          open(event.url).catch((error: unknown) =>
            send({ type: "info", message: `The browser did not open (${(error as Error).message}). Copy the link instead.` }),
          );
        if (event.type === "device_code") report(event.verificationUri);
        if (event.type === "info") for (const link of event.links ?? []) report(link.url);
        send(event);
      },
    },
  }).then(
    (done): LoginOutcome => ({ ok: true, verified: done.verified }),
    (error: unknown): LoginOutcome =>
      error instanceof SignInCancelled ? { ok: false, cancelled: true }
        : { ok: false, error: error instanceof Error ? error.message : String(error) },
  );

  return {
    result,
    answer(id: string, value: string) {
      pending.get(id)?.(value);
    },
    cancel() {
      abort.abort();
    },
    async reopen(url: string) {
      if (!reported.has(url)) throw new Error("Not a URL this sign-in reported");
      await open(url);
    },
  };
}
