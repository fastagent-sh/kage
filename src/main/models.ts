import type { Agent, AgentInfo } from "@fastagent-sh/fastagent";
import { specOf } from "../shared/model-spec.ts";
import { retired } from "./providers.ts";

export { refOf, specOf } from "../shared/model-spec.ts";

export interface ModelChoice {
  /** `provider/modelId`, which is how duang names a model everywhere outside FastAgent's API. */
  spec: string;
  name?: string;
  contextWindow?: number;
}
export type Models = ModelChoice[];

// Configuration, not a health check: OAuth refresh and provider errors surface at execution.
export function choicesOf({ models }: AgentInfo): Models {
  return models
    .map(({ name, contextWindow, ...ref }): ModelChoice => ({
      spec: specOf(ref),
      ...(name !== undefined && { name }),
      ...(contextWindow !== undefined && { contextWindow }),
    }))
    .filter((model) => !retired(model.spec));
}

export async function modelsOf(agent: Agent): Promise<Models> {
  return choicesOf(await agent.info());
}

/** Whether the agent can run this model now: its provider has a credential here and offers it. */
export async function offered(agent: Agent, model: string): Promise<boolean> {
  return (await modelsOf(agent)).some((candidate) => candidate.spec === model);
}
