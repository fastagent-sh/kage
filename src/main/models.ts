import type { Agent, AgentInfo, SessionChanges, ThinkingLevel } from "@fastagent-sh/fastagent";
import { refOf, specOf } from "../shared/model-spec.ts";
import { retired } from "./providers.ts";

export { refOf, specOf } from "../shared/model-spec.ts";

export interface ModelChoice {
  /** `provider/modelId`, which is how kage names a model everywhere outside FastAgent's API. */
  spec: string;
  name?: string;
  contextWindow?: number;
  /** The effort levels the model supports, lowest first; `["off"]` for one that does not reason. */
  thinkingLevels: readonly ThinkingLevel[];
}
export type Models = ModelChoice[];

// Configuration, not a health check: OAuth refresh and provider errors surface at execution.
export function choicesOf({ models }: AgentInfo): Models {
  return models
    .map(({ name, contextWindow, thinkingLevels, ...ref }): ModelChoice => ({
      spec: specOf(ref),
      thinkingLevels,
      ...(name !== undefined && { name }),
      ...(contextWindow !== undefined && { contextWindow }),
    }))
    .filter((model) => !retired(model.spec));
}

export async function modelsOf(agent: Agent): Promise<Models> {
  return choicesOf(await agent.info());
}

/**
 * The model a conversation runs on (its own, else kage's default for the agent, else the config's) and the
 * effort levels it supports. FastAgent clamps an unsupported level when it calls the provider, which would leave
 * the level shown and the level used apart.
 */
export async function effortOf(agent: Agent, sessionId: string, agentDefault?: string): Promise<ModelChoice | undefined> {
  const [session, info] = await Promise.all([agent.sessions.get(sessionId), agent.info()]);
  const ref = session.model ?? info.defaultModel;
  const spec = session.model ? specOf(session.model) : (agentDefault ?? (ref && specOf(ref)));
  return choicesOf(info).find((model) => model.spec === spec);
}

/**
 * What moving a conversation to `model` changes: its model, and its effort when the new model lacks the level it
 * had, which goes back to the agent's rather than staying on screen as a level that would be clamped.
 */
export async function changesForModel(agent: Agent, sessionId: string, model: string): Promise<SessionChanges> {
  const [session, info] = await Promise.all([agent.sessions.get(sessionId), agent.info()]);
  const supported = choicesOf(info).find((choice) => choice.spec === model)?.thinkingLevels;
  const stale = session.thinkingLevel !== undefined && !supported?.includes(session.thinkingLevel);
  return { model: refOf(model), ...(stale && { thinkingLevel: null }) };
}

/** Whether the agent can run this model now: its provider has a credential here and offers it. */
export async function offered(agent: Agent, model: string): Promise<boolean> {
  return (await modelsOf(agent)).some((candidate) => candidate.spec === model);
}
