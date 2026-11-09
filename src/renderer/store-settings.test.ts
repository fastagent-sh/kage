import assert from "node:assert/strict";
import { test } from "node:test";
import type { KageApi, LoginOutcome, ProviderRow } from "../preload/index.ts";
import { keyStep } from "./settings-store.ts";
import { deferred, harness } from "./store-harness.ts";


test("settings are read fresh each time, and only the newest change and check land", async () => {
  const { api, store } = harness();
  type Checked = Awaited<ReturnType<KageApi["testNetwork"]>>;
  type Routed = Awaited<ReturnType<KageApi["setNetwork"]>>;
  api.getSettings = async () => {
    throw new Error("settings.json: Unexpected token");
  };
  assert.equal(await store.loadSettings(), undefined);
  assert.equal(store.getSnapshot().settingsError, "settings.json: Unexpected token");
  assert.equal(store.getSnapshot().settings, undefined, "an unreadable file is not shown as the defaults");

  const staleCheck = deferred<Checked>();
  const freshCheck = deferred<Checked>();
  const checks = [staleCheck.promise, freshCheck.promise];
  api.testNetwork = () => checks.shift()!;
  api.getSettings = async () => ({ network: { mode: "automatic" }, avatar: "gaze" });
  assert.deepEqual((await store.loadSettings())?.network, { mode: "automatic" });
  assert.equal(store.getSnapshot().settingsError, undefined);
  assert.deepEqual(store.getSnapshot().connection, { checking: true });

  // Two quick choices: the first answer arrives last. It must not win, and it reports nothing.
  const slow = deferred<Routed>();
  const fast = deferred<Routed>();
  const routes = [slow.promise, fast.promise];
  api.setNetwork = () => routes.shift()!;
  const manual = store.setNetwork({ mode: "manual", url: "http://127.0.0.1:7890" });
  const off = store.setNetwork({ mode: "off" });
  fast.resolve({ source: "off" });
  assert.equal(await off, undefined);
  slow.reject(new Error("proxy refused"));
  assert.equal(await manual, undefined, "a superseded choice's failure is not the page's problem");
  assert.deepEqual(store.getSnapshot().settings, { network: { mode: "off" }, route: { source: "off" } });

  // The check started for the old route answers after the one for the new route.
  freshCheck.resolve({ status: 200, ms: 12, route: { source: "off" } });
  await new Promise((resolve) => setImmediate(resolve));
  staleCheck.resolve({ status: 407, ms: 3, route: { source: "system" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(store.getSnapshot().connection, { status: 200, ms: 12, route: { source: "off" } });

  // A choice that fails on its own says why, to the form that made it.
  api.setNetwork = async () => {
    throw new Error("Not a URL: nope");
  };
  assert.equal(await store.setNetwork({ mode: "manual", url: "nope" }), "Not a URL: nope");
  store.dispose();
});


test("plan usage is kept per provider, and a failed read replaces the numbers with its reason", async () => {
  const { api, store } = harness();
  const data = { provider: "anthropic", windows: [{ label: "5h", percent: 4, windowSeconds: 18_000 }], fetchedAt: 1 };
  api.providerUsage = async () => data;
  await store.loadUsage("anthropic");
  assert.deepEqual(store.getSnapshot().usage.anthropic, { data });

  api.providerUsage = async () => {
    throw new Error("Error invoking remote method 'usage:get': Error: api.anthropic.com answered 429: rate limited");
  };
  await store.loadUsage("anthropic");
  assert.deepEqual(
    store.getSnapshot().usage.anthropic,
    { error: "api.anthropic.com answered 429: rate limited" },
    "a stale percentage must not stay on screen as current",
  );

  api.providerUsage = async () => data;
  await store.loadUsage("anthropic");
  await store.disconnect("anthropic");
  assert.equal(store.getSnapshot().usage.anthropic, undefined, "a disconnected plan's numbers go with it");
  store.dispose();
});


test("a sign-in shows what its flow asks, sends the answer once, and ends by its outcome", async () => {
  const { api, store, step } = harness();
  await store.load();
  const anthropic: ProviderRow = {
    id: "anthropic",
    name: "Anthropic",
    ways: [
      { method: "oauth", label: "Anthropic (Claude Pro/Max)", subscription: true },
      { method: "api_key", label: "Anthropic API key", subscription: false },
    ],
  };
  const lists = [[anthropic], [{ ...anthropic, stored: "api_key" as const }]];
  api.listProviders = async () => lists.shift()!;
  await store.loadProviders();
  const answers: [string, string][] = [];
  api.answerLogin = async (id, value) => void answers.push([id, value]);
  const done = deferred<LoginOutcome>();
  api.login = () => done.promise;

  const connecting = store.connect(anthropic, anthropic.ways[1]!);
  step({ type: "prompt", id: "1", prompt: { type: "secret", message: "Anthropic API key" } });
  step({ type: "info", message: "Keys start with sk-ant-" });
  assert.equal(store.getSnapshot().signIn?.prompt?.prompt.type, "secret");
  await store.answerSignIn("sk-ant-typed");
  assert.deepEqual(answers, [["1", "sk-ant-typed"]]);
  assert.equal(store.getSnapshot().signIn?.prompt, undefined, "the field, and what was typed, is gone");
  assert.equal(store.getSnapshot().signIn?.info?.message, "Keys start with sk-ant-");
  done.resolve({ ok: true, verified: "ok" });
  await connecting;
  assert.deepEqual(store.getSnapshot().signIn?.outcome, { ok: true, verified: "ok" });
  assert.equal(store.getSnapshot().providers?.[0]?.stored, "api_key", "the list is re-read after it lands");
  step({ type: "info", message: "late" });
  assert.equal(store.getSnapshot().signIn?.info?.message, "Keys start with sk-ant-", "a finished flow takes no more steps");
  await store.closeSignIn();
  assert.equal(store.getSnapshot().signIn, undefined);
  store.dispose();
});


test("cancelling a sign-in closes it with nothing to say; any other end keeps its reason", async () => {
  const { api, store, step } = harness();
  await store.load();
  const openai: ProviderRow = { id: "openai", name: "OpenAI", ways: [{ method: "api_key", label: "OpenAI API key", subscription: false }] };
  const running = deferred<LoginOutcome>();
  api.login = () => running.promise;
  api.cancelLogin = async () => running.resolve({ ok: false, cancelled: true });
  const first = store.connect(openai, openai.ways[0]!);
  step({ type: "prompt", id: "1", prompt: { type: "secret", message: "Key" } });
  await store.closeSignIn();
  await first;
  assert.equal(store.getSnapshot().signIn, undefined, "a decision, not a failure");

  api.login = async () => ({ ok: false, error: "EADDRINUSE: port 1455" });
  await store.connect(openai, openai.ways[0]!);
  assert.deepEqual(store.getSnapshot().signIn?.outcome, { ok: false, error: "EADDRINUSE: port 1455" });

  api.listProviders = async () => {
    throw new Error("auth.json: corrupt auth file");
  };
  await store.loadProviders();
  assert.equal(store.getSnapshot().providersError, "auth.json: corrupt auth file");
  assert.equal(store.getSnapshot().providers, undefined, "never shown as nothing connected");
  store.dispose();
});


test("starting another sign-in ends the running one first, since main runs one at a time", async () => {
  const { api, store, step } = harness();
  await store.load();
  const openai: ProviderRow = { id: "openai", name: "OpenAI", ways: [{ method: "api_key", label: "OpenAI API key", subscription: false }] };
  const xai: ProviderRow = { id: "xai", name: "xAI", ways: [{ method: "api_key", label: "xAI API key", subscription: false }] };
  const first = deferred<LoginOutcome>();
  const started: string[] = [];
  let busy = false;
  api.login = async (provider) => {
    // Main's rule: a login that starts before the last one has ended is refused.
    if (busy) return { ok: false, error: "Another sign-in is in progress." };
    busy = true;
    started.push(provider);
    if (provider === "openai") return first.promise.finally(() => (busy = false));
    return new Promise(() => {});
  };
  // Cancelling takes a moment to end in main, as closing a callback server does.
  api.cancelLogin = async () => void setTimeout(() => first.resolve({ ok: false, cancelled: true }), 10);
  const running = store.connect(openai, openai.ways[0]!);
  step({ type: "prompt", id: "1", prompt: { type: "secret", message: "Key" } });
  void store.connect(xai, xai.ways[0]!);
  await running;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ["openai", "xai"]);
  assert.equal(store.getSnapshot().signIn?.provider, xai, "the new sign-in is the one on screen");
  assert.equal(store.getSnapshot().signIn?.outcome, undefined, "and it is running, not refused");
  store.dispose();
});


test("only a key question is a key step: what a flow asks after the key is its own question", async () => {
  const { api, store, step } = harness();
  await store.load();
  const answers: [string, string][] = [];
  api.answerLogin = async (id, value) => void answers.push([id, value]);
  // Runs until cancelled, as main's does.
  let end: (outcome: LoginOutcome) => void = () => {};
  api.login = () => new Promise((resolve) => (end = resolve));
  api.cancelLogin = async () => end({ ok: false, cancelled: true });
  const shown = () => keyStep(store.getSnapshot().signIn!);
  // Cloudflare: the key, then the account ID, which is not a refused key.
  const cloudflare: ProviderRow = { id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", ways: [{ method: "api_key", label: "Cloudflare API key", subscription: false }] };
  void store.connect(cloudflare, cloudflare.ways[0]!);
  step({ type: "prompt", id: "1", prompt: { type: "secret", message: "Cloudflare API key" } });
  assert.equal(shown(), "ask");
  await store.answerSignIn("cf-key");
  assert.equal(shown(), "checking");
  step({ type: "prompt", id: "2", prompt: { type: "text", message: "Enter Cloudflare account ID" } });
  assert.equal(shown(), undefined, "a question of its own, not the key asked again");
  await store.answerSignIn("account-1");
  assert.deepEqual(answers, [["1", "cf-key"], ["2", "account-1"]], "the account ID is what was typed for it");
  assert.equal(shown(), undefined, "waiting after the account ID is not checking a key");
  await store.closeSignIn();

  // Vertex: a refused key starts the flow over at its choice, which is a choice, not the key again.
  const vertex: ProviderRow = { id: "google-vertex", name: "Google Vertex AI", ways: [{ method: "api_key", label: "Vertex AI", subscription: false }] };
  const choice = { type: "select", message: "Auth method", options: [{ id: "api_key", label: "API key" }] } as const;
  void store.connect(vertex, vertex.ways[0]!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  step({ type: "prompt", id: "3", prompt: choice });
  assert.equal(shown(), undefined);
  await store.answerSignIn("api_key");
  step({ type: "prompt", id: "4", prompt: { type: "secret", message: "Vertex API key" } });
  assert.equal(shown(), "ask");
  await store.answerSignIn("bad-key");
  step({ type: "prompt", id: "5", prompt: choice });
  assert.equal(shown(), undefined, "the choice again, not a key field that would send the key as its answer");
  await store.answerSignIn("api_key");
  step({ type: "prompt", id: "6", prompt: { type: "secret", message: "Vertex API key" } });
  assert.equal(shown(), "refused", "the key asked again after one was sent");
  store.dispose();
});


test("a blank answer is sent when the flow asks for one, and a blank key is not", async () => {
  const { api, store, step } = harness();
  await store.load();
  const copilot: ProviderRow = {
    id: "github-copilot",
    name: "GitHub Copilot",
    ways: [{ method: "oauth", label: "GitHub Copilot", subscription: true }],
  };
  const answers: [string, string][] = [];
  api.answerLogin = async (id, value) => void answers.push([id, value]);
  api.login = () => new Promise(() => {});
  void store.connect(copilot, copilot.ways[0]!);
  step({ type: "prompt", id: "1", prompt: { type: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" } });
  await store.answerSignIn("");
  assert.deepEqual(answers, [["1", ""]], "blank means github.com");
  step({ type: "prompt", id: "2", prompt: { type: "secret", message: "Key" } });
  await store.answerSignIn("");
  assert.deepEqual(answers, [["1", ""]], "an empty key is not an answer");
  assert.equal(store.getSnapshot().signIn?.prompt?.id, "2", "the key field stays");
  store.dispose();
});


test("a link the browser will not open is said in the running sign-in", async () => {
  const { api, store, step } = harness();
  await store.load();
  const anthropic: ProviderRow = { id: "anthropic", name: "Anthropic", ways: [{ method: "oauth", label: "Anthropic (Claude Pro/Max)", subscription: true }] };
  api.login = () => new Promise(() => {});
  api.openLoginUrl = async () => {
    throw new Error("no application to open https");
  };
  void store.connect(anthropic, anthropic.ways[0]!);
  step({ type: "auth_url", url: "https://claude.ai/oauth/authorize" });
  await store.openLoginUrl("https://claude.ai/oauth/authorize");
  assert.equal(store.getSnapshot().signIn?.info?.message, "The browser did not open: no application to open https");
  store.dispose();
});
