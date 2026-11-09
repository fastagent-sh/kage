import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent } from "@fastagent-sh/fastagent";
import { changesForModel, choicesOf, effortOf } from "./models.ts";

const model = (provider: string, modelId: string, thinkingLevels: string[]) => ({ provider, modelId, thinkingLevels });
const info = {
  name: "a",
  commands: [],
  tools: [],
  models: [
    model("anthropic", "claude-sonnet-4-5", ["off", "minimal", "low", "medium", "high"]),
    model("openai", "gpt-4o-mini", ["off"]),
    model("openai-codex", "gpt-5.5", ["off", "low"]),
  ],
  defaultModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
};
const agent = (session: object) =>
  ({ info: async () => info, sessions: { get: async () => ({ id: "s", status: "idle", usage: {}, ...session }) } }) as unknown as Agent;

test("a model's levels are the ones FastAgent reports for it, and a retired route is not offered", () => {
  const choices = choicesOf(info as never);
  assert.deepEqual(choices.map((choice) => choice.spec), ["anthropic/claude-sonnet-4-5", "openai/gpt-4o-mini"]);
  assert.deepEqual(choices[1]!.thinkingLevels, ["off"], "a model that does not reason has no choice to make");
});

test("a conversation's effort is judged against the model it will run on: its own, else kage's default, else the config's", async () => {
  const own = { model: { provider: "openai", modelId: "gpt-4o-mini" } };
  assert.equal((await effortOf(agent(own), "s", "anthropic/claude-sonnet-4-5"))?.spec, "openai/gpt-4o-mini", "its own model wins over the default");
  assert.equal((await effortOf(agent({}), "s", "openai/gpt-4o-mini"))?.spec, "openai/gpt-4o-mini", "kage's default for the agent");
  assert.equal((await effortOf(agent({}), "s"))?.spec, "anthropic/claude-sonnet-4-5", "the config's");
  assert.equal(await effortOf(agent({}), "s", "local/gone"), undefined, "a model the agent does not offer has no levels to judge by");
});

test("moving a conversation to a model that lacks its effort level sends the effort back to the agent's, and keeps one the model has", async () => {
  const high = agent({ thinkingLevel: "high" });
  assert.deepEqual(await changesForModel(high, "s", "openai/gpt-4o-mini"), {
    model: { provider: "openai", modelId: "gpt-4o-mini" },
    thinkingLevel: null,
  });
  assert.deepEqual(await changesForModel(high, "s", "anthropic/claude-sonnet-4-5"), {
    model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
  });
  assert.deepEqual(
    await changesForModel(agent({}), "s", "openai/gpt-4o-mini"),
    { model: { provider: "openai", modelId: "gpt-4o-mini" } },
    "a conversation that follows the agent's effort has none to clear",
  );
});
