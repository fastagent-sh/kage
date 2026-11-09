import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = await mkdtemp(join(tmpdir(), "kage-usage-"));
const auth = join(dir, "auth.json");
const { MIN_GAP_MS, forgetUsage, parseAnthropic, providerUsage, usagePage } = await import("./usage.ts");

const HOUR = 3600;

test("the plan's shape parses, and a missing field is an error rather than zero", () => {
  assert.deepEqual(
    parseAnthropic({
      five_hour: { utilization: 4, resets_at: "2026-09-24T06:29:00Z" },
      seven_day: { utilization: 18, resets_at: null },
    }),
    [
      { label: "5h", percent: 4, resetsAt: Date.parse("2026-09-24T06:29:00Z"), windowSeconds: 5 * HOUR },
      { label: "7d", percent: 18, windowSeconds: 7 * 24 * HOUR },
    ],
  );
  assert.throws(() => parseAnthropic({ five_hour: { resets_at: null } }), /five_hour.utilization/);
  assert.throws(() => parseAnthropic({}), /neither five_hour nor seven_day/);
});

test("usage fields must be valid before they reach a renderer", () => {
  for (const utilization of ["70", NaN, Infinity, -Infinity])
    assert.throws(() => parseAnthropic({ five_hour: { utilization } }), /five_hour.utilization must be a finite number/);
  for (const body of [null, [], "response"]) assert.throws(() => parseAnthropic(body), /must be an object/);
  for (const window of [false, [], "window"]) assert.throws(() => parseAnthropic({ five_hour: window }), /five_hour must be an object/);
  for (const resets_at of ["not-a-date", "", 123, []])
    assert.throws(() => parseAnthropic({ five_hour: { utilization: 4, resets_at } }), /five_hour.resets_at must be a valid timestamp/);
  assert.deepEqual(parseAnthropic({ five_hour: null, seven_day: { utilization: 120 } }), [
    { label: "7d", percent: 120, windowSeconds: 7 * 24 * HOUR },
  ]);
});

test("a subscription is read with its own token; an API key has no windows; a refusal keeps the provider's words", async () => {
  const calls: { url: string; authorization: string | null }[] = [];
  let status = 200;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    return status === 200
      ? Response.json({ five_hour: { utilization: 4, resets_at: null }, seven_day: null })
      : new Response("rate limited", { status });
  };
  await writeFile(
    auth,
    JSON.stringify({
      anthropic: { type: "oauth", access: "sk-ant-oat01-test", refresh: "r", expires: Date.now() + 3_600_000 },
      openai: { type: "api_key", key: "sk-test" },
    }),
  );
  const t = Date.now();
  const first = await providerUsage("anthropic", auth, t);
  assert.deepEqual(first.windows, [{ label: "5h", percent: 4, windowSeconds: 5 * HOUR }]);
  assert.deepEqual(calls, [{ url: "https://api.anthropic.com/api/oauth/usage", authorization: "Bearer sk-ant-oat01-test" }]);

  // Within the gap the same answer is reused: a turn ending every minute must not poll a 429-prone route.
  assert.equal(await providerUsage("anthropic", auth, t + MIN_GAP_MS - 1), first);
  assert.equal(calls.length, 1);

  status = 429;
  await assert.rejects(providerUsage("anthropic", auth, t + MIN_GAP_MS), /api\.anthropic\.com answered 429: rate limited/);
  await writeFile(auth, JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-api03-test" } }));
  assert.equal((await providerUsage("anthropic", auth, t + 2 * MIN_GAP_MS)).windows, undefined, "an API key is not a plan");
  assert.equal((await providerUsage("mistral", auth, t)).windows, undefined, "a provider with no usage route");
  assert.equal(calls.length, 2, "neither asked the usage route");

  // Another file's login is another answer, even inside the gap.
  const other = join(dir, "other.json");
  await writeFile(other, JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-api03-other" } }));
  status = 200;
  const t2 = t + 10 * MIN_GAP_MS;
  assert.ok((await providerUsage("anthropic", auth, t2)).windows === undefined);
  await writeFile(
    other,
    JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-other", refresh: "r", expires: Date.now() + 3_600_000 } }),
  );
  assert.deepEqual((await providerUsage("anthropic", other, t2 + 1)).windows, [{ label: "5h", percent: 4, windowSeconds: 5 * HOUR }]);
  assert.equal(calls.at(-1)?.authorization, "Bearer sk-ant-oat01-other");

  // Reconnected inside the gap (an API key replaced by a subscription): the new login is read.
  await writeFile(
    auth,
    JSON.stringify({ anthropic: { type: "oauth", access: "sk-ant-oat01-new", refresh: "r", expires: Date.now() + 3_600_000 } }),
  );
  assert.equal((await providerUsage("anthropic", auth, t2 + 2)).windows, undefined, "still the key's answer until told");
  forgetUsage("anthropic", auth);
  assert.equal((await providerUsage("anthropic", auth, t2 + 3)).windows?.length, 1);
  assert.equal(calls.at(-1)?.authorization, "Bearer sk-ant-oat01-new");
});

test("a malformed endpoint response rejects usage before IPC can forward it", async () => {
  const file = join(dir, "malformed.json");
  await writeFile(file, JSON.stringify({ anthropic: { type: "oauth", access: "test", refresh: "r", expires: Date.now() + 3_600_000 } }));
  globalThis.fetch = async () => Response.json({ five_hour: { utilization: "70", resets_at: null } });
  await assert.rejects(providerUsage("anthropic", file), /five_hour.utilization must be a finite number/);
  globalThis.fetch = async () => Response.json({ five_hour: { utilization: 70, resets_at: null } });
  forgetUsage("anthropic", file);
  assert.equal((await providerUsage("anthropic", file)).windows?.[0]?.percent, 70);
});

test("a ChatGPT sign-in's usage is its own page, which only main can name; an OpenAI key has no plan", async () => {
  let asked = 0;
  globalThis.fetch = async () => {
    asked++;
    return new Response("unexpected", { status: 500 });
  };
  const file = join(dir, "chatgpt.json");
  await writeFile(file, JSON.stringify({ openai: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 } }));
  const signedIn = await providerUsage("openai", file, 1);
  assert.equal(signedIn.page, "ChatGPT");
  assert.equal(signedIn.windows, undefined);
  await writeFile(file, JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));
  forgetUsage("openai", file);
  assert.equal((await providerUsage("openai", file, 2)).page, undefined, "an API key is not a plan");
  assert.equal(asked, 0, "nothing is read over the network for either");
  assert.equal(usagePage("openai"), "https://chatgpt.com/settings/usage");
  assert.throws(() => usagePage("anthropic"), /no usage page/);
});
