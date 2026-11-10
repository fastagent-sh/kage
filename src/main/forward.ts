// A process keeps the environment it was started with, so agent commands are given one fixed proxy, this one, on
// loopback; each connection through it takes the route Chromium resolves for it then, as Clash or Surge do for a
// system proxy. No Electron import, so it is testable.
import { createServer, type IncomingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";
import { pipeline } from "node:stream/promises";
import { connect as connectTls } from "node:tls";
import { request } from "undici";
import { routeOf, RoutedDispatcher } from "./route.ts";

export interface Forwarder {
  url: string;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  "connection",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const endToEnd = (headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>) =>
  Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !HOP_BY_HOP.has(name))) as Record<
    string,
    string | string[]
  >;

const HANDSHAKE_MS = 30_000;

// Resolves with the first `length` bytes once `complete` says how many make a whole answer; the rest stay unread.
function read(socket: Socket, complete: (data: Buffer) => number | undefined): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    socket.setTimeout(HANDSHAKE_MS, () => socket.destroy(new Error(`the proxy did not answer within ${HANDSHAKE_MS / 1000} s`)));
    const cleanup = () => {
      socket.setTimeout(0);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const length = complete(data);
      if (length === undefined) return;
      cleanup();
      socket.pause();
      if (data.length > length) socket.unshift(data.subarray(length));
      resolve(data.subarray(0, length));
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("the proxy closed the connection"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    // The previous read paused it, and a listener does not resume a stream paused on purpose.
    socket.resume();
  });
}

function opened(socket: Socket, event: "connect" | "secureConnect"): Promise<Socket> {
  return new Promise((resolve, reject) => {
    socket.once(event, () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

async function throughHttpProxy(socket: Socket, authority: string): Promise<Socket> {
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  const head = (
    await read(socket, (data) => {
      const end = data.indexOf("\r\n\r\n");
      return end < 0 ? undefined : end + 4;
    })
  ).toString("latin1");
  const status = head.slice(0, head.indexOf("\r\n"));
  if (status.split(" ")[1] !== "200") throw new Error(`the proxy refused ${authority}: ${status}`);
  return socket;
}

async function throughSocks5(socket: Socket, host: string, port: number, authority: string): Promise<Socket> {
  socket.write(Buffer.from([5, 1, 0]));
  const greeting = await read(socket, (data) => (data.length >= 2 ? 2 : undefined));
  if (greeting[1] !== 0) throw new Error("the SOCKS5 proxy asks for a user name and password, which kage cannot give");
  const name = Buffer.from(host);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
  const reply = await read(socket, (data) => {
    if (data.length < 5) return undefined;
    const address = data[3] === 1 ? 4 : data[3] === 4 ? 16 : 1 + data[4]!;
    return data.length >= 6 + address ? 6 + address : undefined;
  });
  if (reply[1] !== 0) throw new Error(`the SOCKS5 proxy refused ${authority} (reply ${reply[1]})`);
  return socket;
}

async function tunnel(resolve: (url: string) => Promise<string>, authority: string): Promise<Socket> {
  const { hostname, port: written } = new URL(`https://${authority}`);
  const host = hostname.replace(/^\[|\]$/g, "");
  const port = Number(written || 443);
  const proxy = routeOf(await resolve(`https://${authority}`));
  if (!proxy) return opened(connect(port, host), "connect");
  const upstream = new URL(proxy);
  const upstreamPort = Number(upstream.port || (upstream.protocol === "https:" ? 443 : upstream.protocol === "socks5:" ? 1080 : 80));
  if (upstream.protocol === "socks5:")
    return throughSocks5(await opened(connect(upstreamPort, upstream.hostname), "connect"), host, port, authority);
  const socket =
    upstream.protocol === "https:"
      ? await opened(connectTls({ host: upstream.hostname, port: upstreamPort, servername: upstream.hostname }), "secureConnect")
      : await opened(connect(upstreamPort, upstream.hostname), "connect");
  return throughHttpProxy(socket, authority);
}

export async function startForwarder(resolve: (url: string) => Promise<string>): Promise<Forwarder> {
  const dispatcher = new RoutedDispatcher(resolve);
  const tunnels = new Set<Socket>();
  const failed = (what: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[kage] an agent command could not reach ${what}: ${message}`);
    return message;
  };

  const server = createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
      if (url.protocol !== "http:") throw new Error();
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("This is kage's proxy for agent commands; it takes proxy requests only.\n");
      return;
    }
    try {
      const hasBody = req.headers["content-length"] !== undefined || req.headers["transfer-encoding"] !== undefined;
      const answer = await request(url, {
        method: req.method as "GET",
        headers: endToEnd(req.headers),
        ...(hasBody && { body: req }),
        dispatcher,
      });
      res.writeHead(answer.statusCode, endToEnd(answer.headers));
      await pipeline(answer.body, res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`${failed(url.host, error)}\n`);
    }
  });

  server.on("connect", (req, client: Socket, head: Buffer) => {
    const authority = req.url ?? "";
    tunnels.add(client);
    client.once("close", () => tunnels.delete(client));
    client.on("error", () => client.destroy());
    tunnel(resolve, authority).then(
      (upstream) => {
        tunnels.add(upstream);
        upstream.once("close", () => {
          tunnels.delete(upstream);
          client.destroy();
        });
        upstream.on("error", () => upstream.destroy());
        client.once("close", () => upstream.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
        upstream.resume();
      },
      (error) => {
        client.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\n\r\n${failed(authority, error)}\n`);
      },
    );
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of tunnels) socket.destroy();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await dispatcher.close();
    },
  };
}
