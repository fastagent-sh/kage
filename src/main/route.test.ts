import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { test } from "node:test";
import { fetch, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { commandProxyEnv, hasCredentials, routeOf, RoutedDispatcher, tryRoute, unreachable } from "./route.ts";

test("a PAC answer becomes the proxy to use, and anything unsupported is an error", () => {
  assert.equal(routeOf("DIRECT"), undefined);
  assert.equal(routeOf("PROXY 127.0.0.1:7897"), "http://127.0.0.1:7897");
  assert.equal(routeOf("PROXY 127.0.0.1:7897; DIRECT"), "http://127.0.0.1:7897");
  assert.equal(routeOf("HTTPS proxy.corp:443"), "https://proxy.corp:443");
  assert.equal(routeOf("SOCKS5 127.0.0.1:7891"), "socks5://127.0.0.1:7891");
  assert.throws(() => routeOf("SOCKS 127.0.0.1:1080"), /Unsupported proxy route "SOCKS 127.0.0.1:1080"/);
});

test("an unusable answer is returned as its reason, so a display or the commands' variables cannot stop the app", () => {
  assert.deepEqual(tryRoute("DIRECT"), {});
  assert.deepEqual(tryRoute("PROXY 127.0.0.1:7897"), { proxy: "http://127.0.0.1:7897" });
  assert.deepEqual(tryRoute("SOCKS 127.0.0.1:1080"), {
    error: 'Unsupported proxy route "SOCKS 127.0.0.1:1080": only PROXY, HTTPS and SOCKS5 are',
  });
});

test("a proxy URL with a user name or password is recognised, with or without a scheme", () => {
  assert.equal(hasCredentials("http://user:pass@proxy.corp:8080"), true);
  assert.equal(hasCredentials("user:pass@127.0.0.1:7890"), true);
  assert.equal(hasCredentials("socks5://user@proxy.corp:1080"), true);
  assert.equal(hasCredentials("http://127.0.0.1:7897"), false);
  assert.equal(hasCredentials("127.0.0.1:7890"), false);
  assert.equal(hasCredentials("http://proxy.corp:8080/path@x"), false);
});

test("commands get one proxy with loopback direct, in both spellings, or nothing", () => {
  const on = commandProxyEnv("http://127.0.0.1:7897");
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"])
    assert.equal(on[name], "http://127.0.0.1:7897", name);
  assert.equal(on.NO_PROXY, "localhost,127.0.0.1,::1");
  assert.equal(on.no_proxy, "localhost,127.0.0.1,::1");
  const off = commandProxyEnv(undefined);
  assert.equal(Object.keys(off).length, 8);
  assert.ok(Object.values(off).every((value) => value === undefined));
});

const listen = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

function proxyServer() {
  let used = 0;
  const server = createServer((req, res) => {
    used++;
    const upstream = httpRequest(req.url!, { method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode!, answer.headers);
      answer.pipe(res);
    });
    req.pipe(upstream);
  });
  server.on("connect", (req, socket, head) => {
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

test("each request follows the route resolved for it, and a dead proxy is an error, not a direct fallback", async () => {
  const target = createServer((_req, res) => res.end("hello"));
  const targetPort = await listen(target);
  const proxy = proxyServer();
  const proxyPort = await listen(proxy.server);
  const dead = createServer();
  const deadPort = await listen(dead);
  await new Promise((resolve) => dead.close(resolve));

  let pac = "DIRECT";
  const asked: string[] = [];
  const dispatcher = new RoutedDispatcher(async (origin) => {
    asked.push(origin);
    return pac;
  });
  const url = `http://127.0.0.1:${targetPort}/`;
  try {
    assert.equal(await (await fetch(url, { dispatcher })).text(), "hello");
    assert.equal(proxy.used(), 0);

    // Switched on between two requests, the way a VPN client flips the system setting.
    pac = `PROXY 127.0.0.1:${proxyPort}`;
    assert.equal(await (await fetch(url, { dispatcher })).text(), "hello");
    assert.equal(proxy.used(), 1, "the second request went through the proxy");
    assert.deepEqual(asked, [`http://127.0.0.1:${targetPort}`, `http://127.0.0.1:${targetPort}`]);

    pac = `PROXY 127.0.0.1:${deadPort}`;
    await assert.rejects(fetch(url, { dispatcher }), (error: Error & { cause?: { code?: string } }) => {
      assert.equal(error.cause?.code, "ECONNREFUSED");
      const report = unreachable("example.test", `http://127.0.0.1:${deadPort}`, error);
      assert.equal(report.code, "ECONNREFUSED");
      assert.match(report.error, new RegExp(`^example\\.test via http://127\\.0\\.0\\.1:${deadPort}: ECONNREFUSED: `));
      return true;
    });
    assert.equal(proxy.used(), 1);

    pac = "SOCKS 127.0.0.1:1080";
    await assert.rejects(fetch(url, { dispatcher }), (error: Error & { cause?: Error }) => {
      assert.match(String(error.cause?.message), /Unsupported proxy route/);
      return true;
    });
  } finally {
    await dispatcher.close();
    target.close();
    proxy.server.close();
  }
});

test("Node's own fetch — what the model SDKs call — follows the installed dispatcher too", async () => {
  const target = createServer((_req, res) => res.end("global"));
  const targetPort = await listen(target);
  const proxy = proxyServer();
  const proxyPort = await listen(proxy.server);
  const previous = getGlobalDispatcher();
  const dispatcher = new RoutedDispatcher(async () => `PROXY 127.0.0.1:${proxyPort}`);
  setGlobalDispatcher(dispatcher);
  try {
    assert.equal(await (await globalThis.fetch(`http://127.0.0.1:${targetPort}/`)).text(), "global");
    assert.equal(proxy.used(), 1);
  } finally {
    setGlobalDispatcher(previous);
    await dispatcher.close();
    target.close();
    proxy.server.close();
  }
});
