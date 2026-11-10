import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { test } from "node:test";
import { startForwarder } from "./forward.ts";

const listen = (server: Server | TcpServer) =>
  new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

// A target that answers each line with "echo:<line>", reached through the tunnel.
function echoServer() {
  return createTcpServer((socket) => socket.on("data", (data) => socket.write(`echo:${data}`)));
}

function httpProxy() {
  let used = 0;
  const server = createServer((req, res) => {
    used++;
    const upstream = httpRequest(req.url!, { method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode!, answer.headers);
      answer.pipe(res);
    });
    req.pipe(upstream);
  });
  server.on("connect", (req, socket: Socket, head) => {
    used++;
    const [host, port] = req.url!.split(":");
    const upstream = connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  });
  return { server, used: () => used };
}

// Enough of RFC 1928 for a CONNECT by name without authentication.
function socks5Proxy() {
  let used = 0;
  const server = createTcpServer((socket) => {
    socket.once("data", () => {
      socket.write(Buffer.from([5, 0]));
      socket.once("data", (request) => {
        used++;
        const length = request[4]!;
        const host = request.subarray(5, 5 + length).toString();
        const port = request.readUInt16BE(5 + length);
        const upstream = connect(port, host, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
      });
    });
  });
  return { server, used: () => used };
}

// A CONNECT through the forwarder, then one line through the tunnel: its answer, or the forwarder's refusal.
function through(forwarder: string, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { port } = new URL(forwarder);
    const req = httpRequest({ host: "127.0.0.1", port, method: "CONNECT", path: authority });
    req.on("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        let body = String(head);
        socket.on("data", (data) => (body += data));
        socket.on("end", () => resolve(`${res.statusCode} ${body.trim()}`));
        return;
      }
      socket.write("ping");
      socket.once("data", (data) => {
        resolve(String(data));
        socket.destroy();
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("each tunnel takes the route resolved when it opens: direct, an HTTP proxy, SOCKS5, or a refusal that says why", async () => {
  const echo = echoServer();
  const echoPort = await listen(echo);
  const http = httpProxy();
  const httpPort = await listen(http.server);
  const socks = socks5Proxy();
  const socksPort = await listen(socks.server);
  let pac = "DIRECT";
  const asked: string[] = [];
  const forwarder = await startForwarder(async (url) => {
    asked.push(url);
    return pac;
  });
  const target = `127.0.0.1:${echoPort}`;
  try {
    assert.equal(await through(forwarder.url, target), "echo:ping");
    assert.deepEqual(asked, [`https://${target}`]);
    assert.equal(http.used() + socks.used(), 0);

    pac = `PROXY 127.0.0.1:${httpPort}`;
    assert.equal(await through(forwarder.url, target), "echo:ping", "a proxy switched on reaches the next connection");
    assert.equal(http.used(), 1);

    pac = `SOCKS5 127.0.0.1:${socksPort}`;
    assert.equal(await through(forwarder.url, target), "echo:ping");
    assert.equal(socks.used(), 1);

    pac = "SOCKS 127.0.0.1:1080";
    assert.match(await through(forwarder.url, target), /^502 Unsupported proxy route "SOCKS 127\.0\.0\.1:1080"/);
    const dead = createTcpServer();
    const deadPort = await listen(dead);
    await new Promise((resolve) => dead.close(resolve));
    pac = `PROXY 127.0.0.1:${deadPort}`;
    assert.match(await through(forwarder.url, target), /^502 connect ECONNREFUSED/, "a dead proxy is an error, not a direct fallback");
  } finally {
    await forwarder.close();
    echo.close();
    http.server.close();
    socks.server.close();
  }
});

test("a plain HTTP request is forwarded on its route, and a request that is not a proxy request is refused", async () => {
  const target = createServer((req, res) => res.end(`hello ${req.method} ${req.url} ${req.headers["x-kept"]}`));
  const targetPort = await listen(target);
  const http = httpProxy();
  const httpPort = await listen(http.server);
  let pac = "DIRECT";
  const forwarder = await startForwarder(async () => pac);
  const get = (path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const { port } = new URL(forwarder.url);
      httpRequest({ host: "127.0.0.1", port, path, headers: { "x-kept": "yes", "proxy-connection": "keep-alive" } }, (res) => {
        let body = "";
        res.on("data", (data) => (body += data));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      })
        .on("error", reject)
        .end();
    });
  try {
    assert.deepEqual(await get(`http://127.0.0.1:${targetPort}/a?b=1`), { status: 200, body: "hello GET /a?b=1 yes" });
    assert.equal(http.used(), 0);
    pac = `PROXY 127.0.0.1:${httpPort}`;
    assert.deepEqual(await get(`http://127.0.0.1:${targetPort}/c`), { status: 200, body: "hello GET /c yes" });
    assert.equal(http.used(), 1);
    assert.equal((await get("/not-a-proxy-request")).status, 400);
  } finally {
    await forwarder.close();
    target.close();
    http.server.close();
  }
});

test("a response that ends early upstream ends the client's connection instead of leaving it waiting", async () => {
  const target = createServer((_req, res) => {
    res.writeHead(200, { "content-length": "100" });
    res.write("part", () => setTimeout(() => res.socket!.destroy(), 20));
  });
  const targetPort = await listen(target);
  const forwarder = await startForwarder(async () => "DIRECT");
  const { port } = new URL(forwarder.url);
  try {
    const ended = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the client was left waiting")), 3000);
      httpRequest({ host: "127.0.0.1", port, path: `http://127.0.0.1:${targetPort}/` }, (res) => {
        res.resume();
        res.once("error", () => resolve("error"));
        res.once("close", () => resolve("close"));
      })
        .on("error", () => resolve("error"))
        .once("close", () => clearTimeout(timer))
        .end();
    });
    assert.ok(["error", "close"].includes(ended));
  } finally {
    await forwarder.close();
    target.close();
  }
});
