import { modelIdOf, providerOf } from "./catalog.ts";

// The reason is always shown verbatim beside this; only its own markers (HTTP status, error code) are read,
// so an unrecognised reason gets the plain title and no guess.

export type Fix = "providers" | "network" | "model";

interface Explained {
  title: string;
  advice?: string;
  fix?: Fix;
}

const RULES: { test: RegExp; explained: Explained }[] = [
  {
    // Checked before the generic 403: the provider refuses where the request comes from, not who sent it.
    test: /unsupported_country|country, region,? or territory|region.*not supported/i,
    explained: {
      title: "The provider does not serve this location",
      advice: "Requests reach it from a region it refuses. A different network route may work.",
      fix: "network",
    },
  },
  {
    test: /\((?:401|403)\)|\b(?:401|403) (?:unauthori[sz]ed|forbidden)|invalid[_ ]api[_ ]key|incorrect api key|authentication|no api key/i,
    explained: {
      title: "The provider did not accept the sign-in",
      advice: "The key or sign-in may have expired or been revoked. Sign in again, then retry.",
      fix: "providers",
    },
  },
  {
    test: /\(429\)|rate.?limit|too many requests|insufficient_quota|quota exceeded|usage limit/i,
    explained: { title: "The provider is limiting requests", advice: "Wait a little and retry, or use another model.", fix: "model" },
  },
  {
    test: /\((?:500|502|503|504|529)\)|overloaded|server_error|internal server error|bad gateway|service unavailable/i,
    explained: {
      title: "The provider had a problem",
      advice: "This is usually brief. Retry in a moment, or use another model.",
      fix: "model",
    },
  },
  {
    test: /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR|fetch failed|connection error|socket hang up|network error|unsupported proxy route/i,
    explained: {
      title: "Could not reach the provider",
      advice: "Check the connection or the proxy in Network settings, then retry.",
      fix: "network",
    },
  },
];

export const recognise = (reason: string): Explained | undefined => RULES.find(({ test }) => test.test(reason))?.explained;

// FastAgent's own codes say what the words would only hint at.
const BY_CODE: Record<string, Explained> = {
  auth_required: {
    title: "This model has no sign-in",
    advice: "Sign in to its provider, or choose a model whose provider is connected.",
    fix: "providers",
  },
  missing_model: { title: "This conversation has no model", advice: "Choose a model for it, then send again.", fix: "model" },
};

export function explainRunFailure(reason: string, code?: string): Explained {
  return (code && BY_CODE[code]) || recognise(reason) || { title: "The run stopped with an error" };
}

// Nothing while the list loads, which would say the wrong thing first.
export function unavailableNotice(model: string, models: readonly { spec: string }[] | undefined): { title: string; connect?: string } | undefined {
  if (!models || models.some(({ spec }) => spec === model)) return undefined;
  const provider = providerOf(model);
  return models.some(({ spec }) => spec.startsWith(`${provider}/`))
    ? { title: `${modelIdOf(model)} isn't available` }
    : { title: `${provider} isn't connected`, connect: provider };
}
