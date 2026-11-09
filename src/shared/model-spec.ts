// kage names a model `provider/modelId` everywhere outside FastAgent's API, which names it by the pair.
export interface ModelRef {
  provider: string;
  modelId: string;
}

export const specOf = ({ provider, modelId }: ModelRef): string => `${provider}/${modelId}`;

// A provider id has no "/"; a model id (an OpenRouter route) may.
export function refOf(spec: string): ModelRef {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) throw new Error(`"${spec}" is not a provider/model`);
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}
