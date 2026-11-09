// Part of the store's one `View`; kept apart because none of it touches a conversation.
import type {
  AvatarStyle,
  KageApi,
  LoginOutcome,
  LoginStep,
  Network,
  ProviderRow,
  Route,
} from "../preload/index.ts";
import { message } from "./message.ts";

export type Connection = { checking: true } | { status: number; ms: number } | { error: string; code?: string };
type Shown<T extends LoginStep["type"]> = Omit<Extract<LoginStep, { type: T }>, "type">;
export interface SignIn {
  provider: ProviderRow;
  way: ProviderRow["ways"][number];
  prompt?: Shown<"prompt">;
  // `instructions` and `progress` are words for a terminal, not kept.
  url?: { url: string };
  device?: Shown<"device_code">;
  info?: Shown<"info">;
  // A key prompt asked again after an answer means the key was refused.
  keyAnswers: number;
  answered?: NonNullable<SignIn["prompt"]>["prompt"]["type"];
  outcome?: Exclude<LoginOutcome, { cancelled: true }>;
}

// Decided by the prompt on screen and the last one answered, never by the count alone: a flow may ask more
// after the key (Cloudflare's account ID) or start over at a choice (Vertex, Bedrock).
export function keyStep(signIn: SignIn): "ask" | "refused" | "checking" | undefined {
  if (signIn.way.method !== "api_key" || signIn.outcome) return undefined;
  if (signIn.prompt) return signIn.prompt.prompt.type !== "secret" ? undefined : signIn.keyAnswers > 0 ? "refused" : "ask";
  return signIn.answered === "secret" ? "checking" : undefined;
}

export interface SettingsView {
  settings?: { network: Network; route: Route };
  // The page says so rather than show the defaults.
  settingsError?: string;
  avatar: AvatarStyle;
  connection?: Connection;
  providers?: ProviderRow[];
  // The page says so, never "none".
  providersError?: string;
  signIn?: SignIn;
}
export function createSettings(
  api: KageApi,
  view: () => SettingsView,
  publish: (patch: Partial<SettingsView>) => void,
  credentialsChanged: (provider: string) => void,
) {
  // A slow check for a route that has since changed must not land on the new one, nor an earlier
  // network choice's answer after a later one's.
  let connectionRequest = 0;
  let networkRequest = 0;
  let settingsRead: object | undefined;

  const onStep = (step: LoginStep) => {
    const s = view().signIn;
    if (!s || s.outcome) return;
    const next: SignIn = { ...s };
    if (step.type === "prompt") next.prompt = { id: step.id, prompt: step.prompt };
    else if (step.type === "dismiss") {
      if (s.prompt?.id === step.id) delete next.prompt;
    } else if (step.type === "auth_url") next.url = { url: step.url };
    else if (step.type === "device_code") {
      const { type: _type, ...device } = step;
      next.device = device;
    } else if (step.type === "info") next.info = { message: step.message, ...(step.links ? { links: step.links } : {}) };
    // `progress` narrates for a terminal what the row already says in its own words.
    else if (step.type === "progress") return;
    publish({ signIn: next });
  };
  let login: Promise<LoginOutcome> | undefined;
  async function loadProviders() {
    try {
      publish({ providers: await api.listProviders(), providersError: undefined });
    } catch (error) {
      publish({ providers: undefined, providersError: message(error) });
    }
  }

  async function checkConnection() {
    const request = ++connectionRequest;
    publish({ connection: { checking: true } });
    try {
      const result = await api.testNetwork();
      if (request === connectionRequest) publish({ connection: result });
    } catch (error) {
      if (request === connectionRequest) publish({ connection: { error: message(error) } });
    }
  }

  return {
    onStep,
    checkConnection,
    loadProviders,
    // Main runs one sign-in at a time and ends a cancelled one only once its callback server closed, so wait.
    async connect(provider: ProviderRow, way: ProviderRow["ways"][number]) {
      while (login) {
        void api.cancelLogin();
        await Promise.allSettled([login]);
      }
      publish({ signIn: { provider, way, keyAnswers: 0 } });
      const mine = (login = api.login(provider.id, way.method));
      let outcome: LoginOutcome;
      try {
        outcome = await mine;
      } catch (error) {
        outcome = { ok: false, error: message(error) };
      } finally {
        if (login === mine) login = undefined;
      }
      if (outcome.ok) credentialsChanged(provider.id);
      const shown = view().signIn;
      if (shown?.provider !== provider || shown.way !== way) return;
      if (!outcome.ok && outcome.cancelled) return publish({ signIn: undefined });
      const { prompt: _prompt, ...rest } = shown;
      publish({ signIn: { ...rest, outcome } });
      if (outcome.ok) await loadProviders();
    },
    // A blank answer is an answer (Copilot's "blank for github.com", Bedrock's "press Enter"); only a key cannot be.
    async answerSignIn(value: string) {
      const s = view().signIn;
      const prompt = s?.prompt;
      if (!s || !prompt || (prompt.prompt.type === "secret" && !value)) return;
      const secret = prompt.prompt.type === "secret";
      publish({ signIn: { ...s, prompt: undefined, answered: prompt.prompt.type, keyAnswers: s.keyAnswers + (secret ? 1 : 0) } });
      await api.answerLogin(prompt.id, value);
    },
    async closeSignIn() {
      const s = view().signIn;
      if (!s) return;
      if (s.outcome) return publish({ signIn: undefined });
      await api.cancelLogin();
    },
    async openLoginUrl(url: string) {
      try {
        await api.openLoginUrl(url);
      } catch (error) {
        // Only a running sign-in's row offers these links; anywhere else a failure stays an error.
        const s = view().signIn;
        if (!s || s.outcome) throw error;
        publish({ signIn: { ...s, info: { message: `The browser did not open: ${message(error)}` } } });
      }
    },
    async revealProviders() {
      try {
        await api.revealProviders();
      } catch (error) {
        publish({ providersError: message(error) });
      }
    },
    async disconnect(provider: string) {
      try {
        await api.disconnect(provider);
      } catch (error) {
        return publish({ providersError: message(error) });
      }
      credentialsChanged(provider);
      await loadProviders();
    },
    // From nothing on every opening: a file fixed by hand shows up, and nothing stale is shown as current.
    async loadSettings(): Promise<{ network: Network; route: Route } | undefined> {
      const request = (settingsRead = {});
      ++connectionRequest;
      publish({ settings: undefined, settingsError: undefined, connection: undefined });
      try {
        const [{ network, avatar }, route] = await Promise.all([api.getSettings(), api.getRoute()]);
        if (settingsRead !== request) return;
        const settings = { network, route };
        publish({ settings, avatar });
        void checkConnection();
        return settings;
      } catch (error) {
        if (settingsRead === request) publish({ settingsError: message(error) });
      }
    },
    async setAvatar(avatar: AvatarStyle): Promise<string | undefined> {
      try {
        await api.setAvatar(avatar);
        publish({ avatar });
      } catch (error) {
        return message(error);
      }
    },
    async setNetwork(network: Network): Promise<string | undefined> {
      settingsRead = undefined;
      ++connectionRequest;
      const request = ++networkRequest;
      try {
        const route = await api.setNetwork(network);
        if (request !== networkRequest) return;
        publish({ settings: { network, route } });
        void checkConnection();
      } catch (error) {
        if (request === networkRequest) return message(error);
      }
    },
    async revealSettings() {
      try {
        await api.revealSettings();
      } catch (error) {
        publish({ settingsError: message(error) });
      }
    },
  };
}
