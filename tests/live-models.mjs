import assert from "node:assert/strict";

// What a ChatGPT sign-in runs: its account refuses the API's older ids (`gpt-5.5`, `gpt-4.1`) with `model_not_found`.
// Checked against a real account on 2026-10-31; a list like this goes stale, which the live check says when it does.
const CHATGPT_SIGN_IN = ["openai/gpt-5.6-luna", "openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-6-luna"];

/** `chatgpt`: the OpenAI credential is a ChatGPT sign-in, not an API key. */
export function selectLiveModels(models, { first, second, chatgpt = false } = {}) {
  const providerOf = (spec) => spec?.slice(0, spec.indexOf("/"));
  const providers = [...new Set(models.map(({ spec }) => providerOf(spec)))];
  const pick = (provider) => {
    const own = models.filter(({ spec }) => providerOf(spec) === provider);
    if (provider === "openai" && chatgpt) {
      const signedIn = CHATGPT_SIGN_IN.find((spec) => own.some((model) => model.spec === spec));
      if (signedIn) return signedIn;
    }
    if (provider === "openai") return own.find(({ spec }) => spec === "openai/gpt-5.5")?.spec ?? own[0]?.spec;
    if (provider === "anthropic") return own.find(({ spec }) => spec.startsWith("anthropic/claude-sonnet"))?.spec ?? own[0]?.spec;
    return own[0]?.spec;
  };
  first ??= pick(providers.includes("openai") ? "openai" : providers[0]);
  const otherProvider = providers.includes("anthropic") && providerOf(first) !== "anthropic"
    ? "anthropic"
    : providers.find((provider) => provider !== providerOf(first));
  second ??= pick(otherProvider);
  const listed = new Set(models.map(({ spec }) => spec));
  assert.ok(
    first && second && listed.has(first) && listed.has(second),
    `needs two listed models: first ${first ?? "not found"}, second ${second ?? "not found"} (listed: ${[...listed].join(", ") || "none"})`,
  );
  assert.notEqual(providerOf(first), providerOf(second), `needs two different providers: ${first} + ${second}`);
  return [first, second];
}

export function assertLiveReply(reply, model) {
  assert.equal(reply.model, model, "the successful run used the chosen model");
  assert.ok(reply.text.trim(), `${model} returned success without an assistant answer`);
}
