// The endpoint is undocumented: a changed shape is an error, never an empty result. ChatGPT's usage route
// refuses our token, so that login answers with its `page`. `providerAuth` refreshes under the file's lock.
import { credentialFile, providerAuth } from "@fastagent-sh/fastagent";

export interface UsageWindow {
  label: string;
  percent: number;
  resetsAt?: number;
  windowSeconds: number;
}

export interface ProviderUsage {
  provider: string;
  windows?: UsageWindow[];
  page?: string;
  fetchedAt: number;
}

// Main owns the address: the window never hands main a URL to open.
const PAGES: Record<string, { plan: string; url: string }> = {
  // Sign in with ChatGPT (OpenAI's guidance: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).
  openai: { plan: "ChatGPT", url: "https://chatgpt.com/settings/usage" },
};
export function usagePage(provider: string): string {
  const page = PAGES[provider];
  if (!page) throw new Error(`${provider} has no usage page`);
  return page.url;
}

const HOUR = 3600;
const DAY = 24 * HOUR;
const TIMEOUT_MS = 10_000;
/** Anthropic's endpoint answers 429 when polled; a turn ending every minute must not poll it. */
export const MIN_GAP_MS = 3 * 60 * 1000;

const label = (seconds: number) => (seconds % DAY === 0 ? `${seconds / DAY}d` : `${Math.round(seconds / HOUR)}h`);

export function parseAnthropic(body: unknown): UsageWindow[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("usage response must be an object");
  const data = body as Record<string, unknown>;
  const window = (w: unknown, seconds: number, name: string): UsageWindow | undefined => {
    if (w === undefined || w === null) return undefined;
    if (typeof w !== "object" || Array.isArray(w)) throw new Error(`${name} must be an object`);
    const { utilization, resets_at } = w as Record<string, unknown>;
    if (utilization === undefined || utilization === null) throw new Error(`usage response has no ${name}.utilization`);
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) throw new Error(`${name}.utilization must be a finite number`);
    let resetsAt: number | undefined;
    if (resets_at !== undefined && resets_at !== null) {
      const parsed = typeof resets_at === "string" ? Date.parse(resets_at) : NaN;
      if (!Number.isFinite(parsed)) throw new Error(`${name}.resets_at must be a valid timestamp`);
      resetsAt = parsed;
    }
    return {
      label: label(seconds),
      percent: utilization,
      ...(resetsAt !== undefined && { resetsAt }),
      windowSeconds: seconds,
    };
  };
  const windows = [window(data.five_hour, 5 * HOUR, "five_hour"), window(data.seven_day, 7 * DAY, "seven_day")];
  const present = windows.filter((w): w is UsageWindow => !!w);
  if (!present.length) throw new Error("usage response has neither five_hour nor seven_day");
  return present;
}

async function get(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`${new URL(url).host} answered ${response.status}: ${body}`);
  }
  return response.json();
}

const endpoints: Record<string, (token: string) => Promise<UsageWindow[]>> = {
  anthropic: async (token) =>
    parseAnthropic(
      await get("https://api.anthropic.com/api/oauth/usage", {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      }),
    ),
};

async function read(provider: string, authPath: string): Promise<ProviderUsage> {
  const fetchedAt = Date.now();
  const endpoint = endpoints[provider];
  if (!endpoint && !PAGES[provider]) return { provider, fetchedAt };
  const auth = await providerAuth(credentialFile(authPath), provider);
  if (auth?.type !== "oauth") return { provider, fetchedAt };
  if (!endpoint) return { provider, page: PAGES[provider]!.plan, fetchedAt };
  const token = auth.apiKey;
  if (!token) throw new Error(`${provider} has no usable login`);
  return { provider, windows: await endpoint(token), fetchedAt };
}

// A failure is kept for the gap too: retrying a 429 sooner keeps it a 429.
const recent = new Map<string, { at: number; answer: Promise<ProviderUsage> }>();

export function forgetUsage(provider: string, authPath: string): void {
  recent.delete(`${authPath}\0${provider}`);
}

export function providerUsage(provider: string, authPath: string, now = Date.now()): Promise<ProviderUsage> {
  const key = `${authPath}\0${provider}`;
  const hit = recent.get(key);
  if (hit && now - hit.at < MIN_GAP_MS) return hit.answer;
  const answer = read(provider, authPath);
  recent.set(key, { at: now, answer });
  return answer;
}
