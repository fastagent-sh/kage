import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLiveReply, selectLiveModels } from "./live-models.mjs";

const models = (...specs) => specs.map((spec) => ({ spec }));

test("the live check prefers OpenAI and Sonnet, otherwise any two listed providers", () => {
  assert.deepEqual(selectLiveModels(models("openai/a", "openai/gpt-5.5", "anthropic/other", "anthropic/claude-sonnet-new")),
    ["openai/gpt-5.5", "anthropic/claude-sonnet-new"]);
  assert.deepEqual(selectLiveModels(models("deepseek/flash", "openai/current")), ["openai/current", "deepseek/flash"]);
  assert.deepEqual(selectLiveModels(models("local/a", "another/b")), ["local/a", "another/b"]);
});

test("a ChatGPT sign-in is offered the models its account runs, an API key the API's own", () => {
  const listed = models("openai/gpt-5.5", "openai/gpt-5.6-luna", "openai/gpt-6-luna", "anthropic/claude-sonnet-4-5");
  assert.deepEqual(selectLiveModels(listed, { chatgpt: true }), ["openai/gpt-5.6-luna", "anthropic/claude-sonnet-4-5"]);
  assert.deepEqual(selectLiveModels(listed), ["openai/gpt-5.5", "anthropic/claude-sonnet-4-5"]);
  assert.deepEqual(selectLiveModels(models("openai/gpt-5.5", "deepseek/flash"), { chatgpt: true }), ["openai/gpt-5.5", "deepseek/flash"], "none of them listed: the usual choice");
});

test("overrides are validated as the final pair, not against an unused default", () => {
  const listed = models("openai/a", "openai/b", "deepseek/c", "another/d");
  assert.deepEqual(selectLiveModels(listed, { first: "another/d", second: "deepseek/c" }), ["another/d", "deepseek/c"]);
  assert.throws(() => selectLiveModels(listed, { second: "openai/b" }), /two different providers/);
  assert.throws(() => selectLiveModels(listed, { first: "openai/gone" }), /two listed models/);
  assert.throws(() => selectLiveModels(listed, { second: "missing/model" }), /two listed models/);
  assert.throws(() => selectLiveModels(models("openai/a", "openai/b")), /two listed models/);
  assert.throws(() => selectLiveModels([]), /listed: none/);
});

test("a successful live run needs its chosen model and a nonempty assistant answer", () => {
  assertLiveReply({ model: "provider/model", text: "OK" }, "provider/model");
  assert.throws(() => assertLiveReply({ model: "provider/model", text: " \n" }, "provider/model"), /without an assistant answer/);
  assert.throws(() => assertLiveReply({ model: "other/model", text: "OK" }, "provider/model"), /chosen model/);
});
