import assert from "node:assert/strict";
import { test } from "node:test";
import type { KageApi } from "../preload/index.ts";
import { deferred, described, harness } from "./store-harness.ts";

test("commands from an earlier visit to the same agent cannot replace a later visit", async () => {
  for (const fails of [false, true]) {
    const { api, store } = harness();
    await store.load();
    const old = deferred<Awaited<ReturnType<KageApi["listCommands"]>>>();
    api.listCommands = () => old.promise;
    const first = store.loadCommands();
    await store.selectAgent("b");
    await store.selectAgent("a");
    api.listCommands = async () => [{ name: "new", description: "" }];
    await store.loadCommands();
    if (fails) old.reject(new Error("old definition failed"));
    else old.resolve([{ name: "old", description: "" }]);
    await first;
    assert.equal(store.getSnapshot().commands[0]?.name, "new");
    assert.equal(store.getSnapshot().commandsError, undefined);
    store.dispose();
  }
});

test("leaving an agent invalidates its model read even without another read", async () => {
  for (const fails of [false, true]) {
    const { api, store } = harness();
    await store.load();
    const old = deferred<Awaited<ReturnType<KageApi["listModels"]>>>();
    api.listModels = () => old.promise;
    const first = store.loadModels();
    await store.selectAgent("b");
    if (fails) old.reject(new Error("A's models failed"));
    else old.resolve(described(["only-a/model"]));
    await first;
    assert.equal(store.getSnapshot().agentId, "b");
    assert.equal(store.getSnapshot().models, undefined);
    assert.equal(store.getSnapshot().modelsError, undefined);
    store.dispose();
  }
});

test("a disconnected provider's unfinished usage read cannot restore its plan", async () => {
  const { api, store } = harness();
  const old = deferred<Awaited<ReturnType<KageApi["providerUsage"]>>>();
  api.providerUsage = () => old.promise;
  const first = store.loadUsage("anthropic");
  await store.disconnect("anthropic");
  old.resolve({ provider: "anthropic", fetchedAt: 1 });
  await first;
  assert.equal(store.getSnapshot().usage.anthropic, undefined);
  store.dispose();
});

test("replacing a login invalidates its old plan and later reads win per provider", async () => {
  const { api, store } = harness();
  const old = deferred<Awaited<ReturnType<KageApi["providerUsage"]>>>();
  api.providerUsage = () => old.promise;
  const first = store.loadUsage("anthropic");
  const provider = { id: "anthropic", name: "Anthropic", ways: [{ method: "oauth" as const, label: "Subscription", subscription: true }] };
  await store.connect(provider, provider.ways[0]!);
  const current = { provider: "anthropic", fetchedAt: 2 };
  api.providerUsage = async () => current;
  await store.loadUsage("anthropic");
  old.resolve({ provider: "anthropic", fetchedAt: 1 });
  await first;
  assert.deepEqual(store.getSnapshot().usage.anthropic, { data: current });
  store.dispose();
});

test("an older settings opening cannot replace a newer read or choice", async () => {
  for (const choose of [false, true]) {
    const { api, store } = harness();
    const old = deferred<Awaited<ReturnType<KageApi["getSettings"]>>>();
    api.getSettings = () => old.promise;
    const first = store.loadSettings();
    if (choose) {
      api.setNetwork = async () => ({ source: "off" });
      await store.setNetwork({ mode: "off" });
    } else {
      api.getSettings = async () => ({ network: { mode: "off" }, avatar: "clay" });
      await store.loadSettings();
    }
    old.resolve({ network: { mode: "automatic" }, avatar: "gaze" });
    assert.equal(await first, undefined);
    assert.equal(store.getSnapshot().settings?.network.mode, "off");
    store.dispose();
  }
});
