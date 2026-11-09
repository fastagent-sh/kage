// Node's fetch ignores the system proxy and a startup snapshot misses VPNs and PAC changes, so every request
// asks Chromium (route.ts); the Network setting only configures Chromium.
import { app, session } from "electron";
import { join } from "node:path";
import { setGlobalDispatcher } from "undici";
import { writeTextAtomic } from "./json-file.ts";
import { commandEnvScript, commandProxyEnv, hasCredentials, RoutedDispatcher, tryRoute, unreachable } from "./route.ts";
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
let commandError: string | undefined;
let installed = false;

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
    setGlobalDispatcher(
      new RoutedDispatcher((origin) =>
        launchUnusable() ? Promise.reject(new Error(launchCredentials)) : session.defaultSession.resolveProxy(origin),
      ),
    );
    installed = true;
  }
  await syncCommandProxy();
}

export async function describeRoute(): Promise<Route> {
  const route = launchUnusable()
    ? { error: launchCredentials! }
    : tryRoute(await session.defaultSession.resolveProxy(MODEL_HOST));
  const source: Source = current.mode === "automatic" ? (launchUrl ? "environment" : "system") : current.mode === "manual" ? "manual" : "off";
  return {
    ...route,
    source,
    ...(source === "environment" ? { variable: launchVariable } : {}),
    ...(commandError ? { commandError } : {}),
  };
}

// FastAgent fixes an agent's environment when the agent opens, and reopening one mid-conversation would cut the
// window's live view of it. Bash runs this file (BASH_ENV) before every command, so the route in force when a
// command starts reaches it; processes started by other means keep the environment the agent opened with.
export const commandEnvFile = join(app.getPath("userData"), "command-env.sh");
let writtenScript: string | undefined;
async function writeCommandEnv(script: string): Promise<void> {
  if (script === writtenScript) return;
  await writeTextAtomic(commandEnvFile, script);
  writtenScript = script;
}

// Runs before every send, and at launch, so the file exists before an agent opens.
export async function syncCommandProxy(): Promise<void> {
  if (launchUrl) return writeCommandEnv("");
  const route = tryRoute(await session.defaultSession.resolveProxy(COMMAND_HOST));
  // A route the variables cannot express costs the commands their proxy (never a stale one), not the send.
  commandError = "error" in route ? `Agent commands get no proxy: ${route.error}` : undefined;
  if (commandError) console.error(`[kage] ${commandError}`);
  const proxy = "error" in route ? undefined : route.proxy;
  const env = commandProxyEnv(proxy);
  for (const [name, value] of Object.entries(env)) {
    if (presentAtLaunch.has(name)) continue;
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await writeCommandEnv(commandEnvScript(env, presentAtLaunch));
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
