import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialFile, SignInCancelled } from "@fastagent-sh/fastagent";
import { disconnect, listProviders, openable, startLogin, type LoginStep } from "./providers.ts";

const dir = await mkdtemp(join(tmpdir(), "kage-providers-"));

test("providers list pi's own names and ways, what kage's file holds, and a variable the file hides", async () => {
  const auth = join(dir, "list.json");
  await writeFile(auth, JSON.stringify({ openai: { type: "api_key", key: "sk-stored" } }), { mode: 0o600 });
  process.env.OPENAI_API_KEY = "sk-env";
  try {
    const rows = await listProviders(credentialFile(auth));
    const openai = rows.find((row) => row.id === "openai")!;
    assert.equal(openai.name, "OpenAI");
    assert.equal(openai.stored, "api_key");
    assert.equal(openai.ambient, "OPENAI_API_KEY", "the stored key must not hide the variable that outlives a disconnect");
    assert.deepEqual(
      openai.ways.map((way) => [way.method, way.subscription]),
      [["oauth", true], ["api_key", false]],
      "Sign in with ChatGPT is OpenAI's own subscription way, beside its key",
    );
    assert.equal(rows.find((row) => row.id === "openai-codex"), undefined, "pi's retired ChatGPT route is not offered");
    const anthropic = rows.find((row) => row.id === "anthropic")!;
    assert.deepEqual(anthropic.ways.map((way) => way.method), ["oauth", "api_key"]);
    assert.equal(anthropic.stored, undefined);
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test("disconnect removes only that provider from kage's file, and a corrupt file is an error", async () => {
  const auth = join(dir, "disconnect.json");
  await writeFile(
    auth,
    JSON.stringify({ openai: { type: "api_key", key: "a" }, anthropic: { type: "api_key", key: "b" } }),
    { mode: 0o600 },
  );
  await disconnect(credentialFile(auth), "openai");
  assert.deepEqual(Object.keys(JSON.parse(await readFile(auth, "utf8"))), ["anthropic"]);

  const corrupt = join(dir, "corrupt.json");
  await writeFile(corrupt, "{nope");
  await assert.rejects(listProviders(credentialFile(corrupt)), /corrupt/, "never shown as nothing connected");
});

test("only https, or http to this machine, may be opened", () => {
  assert.ok(openable("https://claude.ai/oauth/authorize?x=1"));
  assert.ok(openable("http://localhost:1455/auth/callback"));
  assert.ok(!openable("http://example.com/"));
  assert.ok(!openable("file:///etc/passwd"));
  assert.ok(!openable("javascript:alert(1)"));
});

test("a sign-in relays prompts and events, withdraws a prompt its flow no longer needs, and reopens only its own URLs", async () => {
  const sent: LoginStep[] = [];
  const opened: string[] = [];
  let finish!: () => void;
  const flow = startLogin({
    provider: "anthropic",
    method: "oauth",
    credentials: credentialFile(join(dir, "flow.json")),
    send: (step) => sent.push(step),
    open: async (url) => void opened.push(url),
    run: async ({ interaction }) => {
      interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize" });
      interaction.notify({ type: "auth_url", url: "http://evil.example/" });
      // The browser callback wins: the pasted-code prompt is withdrawn.
      const race = new AbortController();
      const pasted = interaction.prompt({ type: "manual_code", message: "Paste the code", signal: race.signal });
      race.abort();
      await pasted.catch(() => {});
      const answer = await interaction.prompt({ type: "secret", message: "Key" });
      assert.equal(answer, "typed");
      await new Promise<void>((resolve) => (finish = resolve));
      return { provider: "anthropic", method: "oauth", verified: "n/a" };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, ["https://claude.ai/oauth/authorize"], "the sign-in page opens itself; a non-https page never");
  assert.deepEqual(
    sent.filter((step) => step.type === "prompt" || step.type === "dismiss").map((step) => [step.type, "id" in step && step.id]),
    [
      ["prompt", "1"],
      ["dismiss", "1"],
      ["prompt", "2"],
    ],
  );
  const shown = sent.find((step) => step.type === "prompt" && step.id === "1");
  assert.equal(shown && "prompt" in shown && "signal" in shown.prompt, false, "an AbortSignal never crosses IPC");
  flow.answer("1", "late"); // withdrawn: ignored
  flow.answer("2", "typed");
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  assert.deepEqual(await flow.result, { ok: true, verified: "n/a" });
  await flow.reopen("https://claude.ai/oauth/authorize");
  await assert.rejects(flow.reopen("https://elsewhere.example/"), /Not a URL this sign-in reported/);
});

test("a browser that does not open is said, and reopening it rejects", async () => {
  const sent: LoginStep[] = [];
  const flow = startLogin({
    provider: "anthropic",
    method: "oauth",
    credentials: credentialFile(join(dir, "nobrowser.json")),
    send: (step) => sent.push(step),
    open: async () => {
      throw new Error("no application to open https");
    },
    run: async ({ interaction }) => {
      interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize" });
      return new Promise(() => {});
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    sent.some((step) => step.type === "info" && step.message.includes("no application to open https")),
    "the row says why nothing opened",
  );
  await assert.rejects(flow.reopen("https://claude.ai/oauth/authorize"), /no application to open https/);
  flow.cancel();
});

test("cancelling ends the flow as a decision, not a failure", async () => {
  const flow = startLogin({
    provider: "openai",
    method: "api_key",
    credentials: credentialFile(join(dir, "cancel.json")),
    send: () => {},
    open: async () => {},
    run: async ({ interaction }) => {
      await interaction.prompt({ type: "secret", message: "Key" }).catch(() => {
        throw new SignInCancelled("cancelled");
      });
      throw new Error("unreachable");
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  flow.cancel();
  assert.deepEqual(await flow.result, { ok: false, cancelled: true });

  const failed = startLogin({
    provider: "openai",
    method: "api_key",
    credentials: credentialFile(join(dir, "fail.json")),
    send: () => {},
    open: async () => {},
    run: async () => {
      throw new Error("EADDRINUSE: port 1455");
    },
  });
  assert.deepEqual(await failed.result, { ok: false, error: "EADDRINUSE: port 1455" }, "the original message");
});
