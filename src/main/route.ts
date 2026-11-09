import { Agent, Dispatcher, ProxyAgent, Socks5ProxyAgent } from "undici";

// ponytail: only the first entry is used; honour the fallback list when someone's PAC relies on it.
export function routeOf(pac: string): string | undefined {
  const [kind = "", host] = pac.split(";")[0]!.trim().split(/\s+/);
  switch (kind.toUpperCase()) {
    case "DIRECT":
      return undefined;
    case "PROXY":
      return `http://${host}`;
    case "HTTPS":
      return `https://${host}`;
    case "SOCKS5":
      return `socks5://${host}`;
    default:
      throw new Error(`Unsupported proxy route "${pac}": only PROXY, HTTPS and SOCKS5 are`);
  }
}

export function tryRoute(pac: string): { proxy?: string } | { error: string } {
  try {
    const proxy = routeOf(pac);
    return proxy ? { proxy } : {};
  } catch (error) {
    return { error: (error as Error).message };
  }
}

// Chromium's "PROXY h:p" drops credentials. Read from the string: launch variables often have no scheme.
export const hasCredentials = (url: string) => /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/@]*@/i.test(url);

const failing = (error: Error) =>
  new Agent({
    connect: (_options, callback) => callback(error, null),
  });

// Not cached: a VPN switched on or off is seen by the next request.
export class RoutedDispatcher extends Dispatcher {
  private agents = new Map<string, Dispatcher>();
  private resolve: (origin: string) => Promise<string>;
  constructor(resolve: (origin: string) => Promise<string>) {
    super();
    this.resolve = resolve;
  }

  private agentFor(proxy: string | undefined): Dispatcher {
    const key = proxy ?? "DIRECT";
    let agent = this.agents.get(key);
    if (!agent) {
      agent = !proxy
        ? new Agent()
        : proxy.startsWith("socks5:")
          ? new Socks5ProxyAgent(proxy)
          : new ProxyAgent(proxy);
      this.agents.set(key, agent);
    }
    return agent;
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    this.resolve(String(options.origin)).then(
      (pac) => {
        let agent: Dispatcher;
        try {
          agent = this.agentFor(routeOf(pac));
        } catch (error) {
          agent = failing(error as Error);
        }
        agent.dispatch(options, handler);
      },
      (error: Error) => failing(new Error(`Could not resolve a route: ${error.message}`)).dispatch(options, handler),
    );
    return true;
  }

  async close(): Promise<void> {
    await Promise.all([...this.agents.values()].map((agent) => agent.close()));
  }

  async destroy(): Promise<void> {
    await Promise.all([...this.agents.values()].map((agent) => agent.destroy()));
  }
}

// Both spellings: curl reads only lowercase. Per-host PAC rules and the bypass list cannot be expressed here.
export function commandProxyEnv(proxy: string | undefined): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]) env[name] = env[name.toLowerCase()] = proxy;
  env.NO_PROXY = env.no_proxy = proxy && "localhost,127.0.0.1,::1";
  return env;
}

const shellQuoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** What bash runs before a command to give it `env`: a value is exported, an absent one unset. Names in `keep` are left as they are. */
export function commandEnvScript(env: Record<string, string | undefined>, keep: ReadonlySet<string>): string {
  return Object.entries(env)
    .filter(([name]) => !keep.has(name))
    .map(([name, value]) => (value === undefined ? `unset ${name}\n` : `export ${name}=${shellQuoted(value)}\n`))
    .join("");
}

export function unreachable(host: string, proxy: string | undefined, error: unknown): { error: string; code?: string } {
  const cause = (error as Error & { cause?: Error & { code?: string } }).cause;
  const why = cause ? `${cause.code ? `${cause.code}: ` : ""}${cause.message}` : (error as Error).message;
  return { error: `${host} ${proxy ? `via ${proxy}` : "directly"}: ${why}`, ...(cause?.code ? { code: cause.code } : {}) };
}
