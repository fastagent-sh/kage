// Node's fetch ignores the system proxy and a startup snapshot misses VPNs and PAC changes, so every request
// asks Chromium (route.ts); the Network setting only configures Chromium.
import { session } from "electron";
import { setGlobalDispatcher } from "undici";
import { startForwarder, type Forwarder } from "./forward.ts";
import { commandProxyEnv, hasCredentials, RoutedDispatcher, tryRoute, unreachable } from "./route.ts";
import type { Network } from "./settings.ts";

const MODEL_HOST = "https://api.anthropic.com";
const COMMAND_HOST = "https://github.com";
const TEST_TIMEOUT_MS = 10_000;

// A proxy exported in the launching terminal is used by Automatic and never rewritten for agent commands.
const LAUNCH_VARIABLES = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
const launchVariable = LAUNCH_VARIABLES.find((name) => process.env[name]);
const launchUrl = launchVariable ? process.env[launchVariable] : undefined;
const presentAtLaunch = new Set(Object.keys(process.env));
// Chromium's route answer drops a launch proxy's credentials: say so rather than show a bare 407.
const launchCredentials =
  launchUrl && hasCredentials(launchUrl)
    ? `${launchVariable} carries a user name and password, and kage cannot authenticate to a proxy yet. Relaunch without them, or choose Manual with a proxy that needs none, or Off.`
    : undefined;
const launchUnusable = () => current.mode === "automatic" && launchCredentials !== undefined;

export type Source = "system" | "environment" | "manual" | "off";
export interface Route {
  proxy?: string;
  source: Source;
  variable?: string;
  error?: string;
  commandError?: string;
}

let current: Network = { mode: "automatic" };
let installed = false;

const resolveRoute = (url: string) =>
  launchUnusable() ? Promise.reject(new Error(launchCredentials)) : session.defaultSession.resolveProxy(url);

export async function applyNetwork(network: Network): Promise<void> {
  const config: Electron.ProxyConfig =
    network.mode === "off"
      ? { mode: "direct" }
      : network.mode === "manual"
        ? { mode: "fixed_servers", proxyRules: network.url }
        : launchUrl
          ? {
              mode: "fixed_servers",
              proxyRules: launchUrl,
              proxyBypassRules: process.env.NO_PROXY ?? process.env.no_proxy ?? "",
            }
          : { mode: "system" };
  await session.defaultSession.setProxy(config);
  // Connections Chromium already holds would keep an old proxy; the next request must use the new one.
  await session.defaultSession.closeAllConnections();
  current = network;
  if (!installed) {
    setGlobalDispatcher(new RoutedDispatcher(resolveRoute));
    installed = true;
  }
}

export async function describeRoute(): Promise<Route> {
  const route = launchUnusable()
    ? { error: launchCredentials! }
    : tryRoute(await session.defaultSession.resolveProxy(MODEL_HOST));
  const command = launchUrl ? {} : tryRoute(await session.defaultSession.resolveProxy(COMMAND_HOST));
  const commandError = "error" in command ? `Agent commands cannot connect through it: ${command.error}` : undefined;
  const source: Source = current.mode === "automatic" ? (launchUrl ? "environment" : "system") : current.mode === "manual" ? "manual" : "off";
  return {
    ...route,
    source,
    ...(source === "environment" ? { variable: launchVariable } : {}),
    ...(commandError ? { commandError } : {}),
  };
}

let forwarder: Promise<Forwarder> | undefined;

/**
 * The proxy variables an agent's commands start with: kage's forwarder, whose route follows the Network setting for
 * each connection. A proxy exported in the launching terminal is the commands' own and is left as it is.
 */
export async function commandProxyEnvironment(): Promise<Record<string, string>> {
  if (launchUrl) return {};
  if (!forwarder) {
    const starting = startForwarder(resolveRoute);
    forwarder = starting;
    starting.catch(() => {
      if (forwarder === starting) forwarder = undefined;
    });
  }
  const { url } = await forwarder;
  return Object.fromEntries(
    Object.entries(commandProxyEnv(url)).flatMap(([name, value]) => (value === undefined || presentAtLaunch.has(name) ? [] : [[name, value]])),
  );
}

export type ConnectionCheck = { status: number; ms: number; route: Route } | { error: string; code?: string };

export async function testConnection(): Promise<ConnectionCheck> {
  const route = await describeRoute();
  if (route.error) return { error: `${new URL(MODEL_HOST).host}: ${route.error}` };
  const started = performance.now();
  try {
    const response = await fetch(MODEL_HOST, { method: "HEAD", signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
    return { status: response.status, ms: Math.round(performance.now() - started), route };
  } catch (error) {
    return unreachable(new URL(MODEL_HOST).host, route.proxy, error);
  }
}
