import { app } from "electron";
import { join } from "node:path";
import { openAgent as openFastAgent, type LocalAgent } from "@fastagent-sh/fastagent";
import type { Result } from "../shared/result.ts";
import { credentials } from "./credential-file.ts";
import { choicesOf, offered, refOf, specOf } from "./models.ts";
import { runningSessions, stopRuns } from "./runs.ts";
import { refuse } from "./send.ts";
import { summaries, type SessionSummary } from "./session-list.ts";
import {
  AgentRegistry,
  failingConfig,
  freshConfig,
  hasAgent,
  MissingDirError,
  requireFolder,
  type AgentRow,
} from "./agent-files.ts";

export { createAgentIn } from "./agent-files.ts";
export const registryFile = join(app.getPath("userData"), "agents.json");
const registry = new AgentRegistry(registryFile);
export const listAgents = () => registry.list();
export const addAgent = (dir: string) => registry.add(dir);
export const renameAgent = (id: string, name: string) => registry.rename(id, name);

// One instance of the agent per duang, kept apart from the one `fastagent dev` opens in the same folder.
const instanceDir = (id: string) => join(app.getPath("userData"), "instances", id);

/** Why an agent is not ready: no agent in this folder yet, its folder is gone, or its definition does not load. */
export type AgentSetup = "no_agent" | "missing_dir" | "broken";

/** What the window's open call answers: the agent's sessions and model, or why it could not be opened. */
export type OpenResult =
  | { ok: true; sessions: SessionSummary[]; model?: string; staleDefault?: string; windows: Record<string, number> }
  | { ok: false; code: AgentSetup; message: string; inConfig?: true };

// Agent-scoped admission: sends share (a count); removing or moving an agent excludes them, including a send
// still opening its runtime.
const opened = new Map<string, Promise<LocalAgent>>();
const sending = new Map<string, number>();
const changing = new Map<string, Promise<void>>();

class NoAgentError extends Error {}
// Main keeps the failing path rather than taking one from the window.
const failedConfigs = new Map<string, string>();

async function build(row: AgentRow): Promise<LocalAgent> {
  // Before anything can fail: a failure that is not the config's must not offer to replace it.
  // A missing folder must fail here: FastAgent opens it as an empty agent and would create files in it.
  failedConfigs.delete(row.id);
  await requireFolder(row.dir);
  if (!(await hasAgent(row.dir))) throw new NoAgentError(`${row.dir} holds no fastagent.config.ts`);
  try {
    return await openFastAgent(row.dir, { credentials, stateDir: instanceDir(row.id) });
  } catch (error) {
    const config = failingConfig(row.dir, error instanceof Error ? error.message : String(error));
    if (config) failedConfigs.set(row.id, config);
    throw error;
  }
}

/** An agent's row in the registry. An unknown id is a bug in this app, so this throws rather than refusing. */
export async function agentRow(agentId: string): Promise<AgentRow> {
  const row = (await listAgents()).find((candidate) => candidate.id === agentId);
  if (!row) throw new Error(`unknown agent ${agentId}`);
  return row;
}

export async function openAgent(row: AgentRow): Promise<LocalAgent> {
  // Wait rather than fail: "try again" is not actionable. The admitting read is stale after the change.
  while (changing.has(row.id)) {
    await changing.get(row.id);
    if (!(await registry.list()).some((a) => a.id === row.id)) throw new Error(`unknown agent ${row.id}`);
  }
  const cached = opened.get(row.id);
  if (cached) return cached;
  const promise = build(row);
  opened.set(row.id, promise);
  void promise.catch(() => {
    if (opened.get(row.id) === promise) opened.delete(row.id);
  });
  return promise;
}

/** The agents this process has open: what quitting has to look at, and nothing it would have to open. */
export async function openedAgents(): Promise<{ id: string; agent: LocalAgent }[]> {
  const settled = await Promise.all(
    [...opened].map(async ([id, promise]) => ({ id, agent: await promise.catch(() => undefined) })),
  );
  return settled.flatMap(({ id, agent }) => (agent ? [{ id, agent }] : []));
}

/**
 * The window's open call: the agent's sessions and its model, or why it could not be opened. Decided here,
 * beside the runtime's own errors, so the window takes one shape and never classifies a condition itself.
 */
export async function openAgentResult(agentId: string): Promise<OpenResult> {
  try {
    const row = await agentRow(agentId);
    const agent = await openAgent(row);
    const info = await agent.info();
    const models = choicesOf(info);
    // duang's own default for the agent, over the config's; one this computer's providers no longer offer cannot start anything.
    const staleDefault = row.model && !models.some(({ spec }) => spec === row.model) ? row.model : undefined;
    const model = row.model ?? (info.defaultModel && specOf(info.defaultModel));
    return {
      ok: true,
      sessions: await summaries(agent),
      windows: Object.fromEntries(models.flatMap(({ spec, contextWindow }) => (contextWindow ? [[spec, contextWindow]] : []))),
      ...(model && { model }),
      ...(staleDefault && { staleDefault }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof NoAgentError) return { ok: false, code: "no_agent", message };
    if (error instanceof MissingDirError) return { ok: false, code: "missing_dir", message };
    return configFailed(agentId) ? { ok: false, code: "broken", message, inConfig: true } : { ok: false, code: "broken", message };
  }
}

/** A conversation to start in: on the agent's default for new ones when this computer can still run it. */
export async function createSession(row: AgentRow): Promise<string> {
  const agent = await openAgent(row);
  const model = row.model && (await offered(agent, row.model)) ? { model: refOf(row.model) } : {};
  return (await agent.sessions.create(model)).id;
}

/** Count admission as busy too: removing or moving an agent must not race a send that is still opening its runtime. */
export async function withAgentRun<T>(row: AgentRow, run: (agent: LocalAgent) => Promise<Result<T>>): Promise<Result<T>> {
  if (changing.has(row.id)) return refuse("agent_changing", "Agent settings are changing; try again.");
  sending.set(row.id, (sending.get(row.id) ?? 0) + 1);
  try {
    return await run(await openAgent(row));
  } finally {
    const remaining = (sending.get(row.id) ?? 1) - 1;
    if (remaining) sending.set(row.id, remaining);
    else sending.delete(row.id);
  }
}

function change(id: string, apply: () => Promise<Result>): Promise<Result> {
  if (changing.has(id)) return Promise.resolve(refuse("agent_changing", "Agent settings are changing; try again."));
  if (sending.has(id))
    return Promise.resolve(
      refuse("agent_busy", "An agent conversation is running — stop it before changing or removing the agent."),
    );
  // Nothing can interleave between starting the work and publishing it: `apply` cannot reach another
  // admission before its first await, and this runs in the same synchronous block.
  const running = (async () => {
    const agent = await opened.get(id)?.catch(() => undefined);
    if (agent && (await runningSessions([{ id, agent }])).length > 0)
      return refuse("agent_busy", "An agent conversation is running — stop it before changing or removing the agent.");
    const result = await apply();
    if (result.ok) {
      // The instance's storage is held by one opener: it must be released for the agent to open again.
      opened.delete(id);
      await agent?.close();
    }
    return result;
  })();
  changing.set(
    id,
    running.then(
      () => {},
      () => {},
    ),
  );
  return running.finally(() => changing.delete(id));
}

/**
 * New conversations start on this model, and the one named (if any) moves to it. Conversations already begun keep
 * the model they record.
 */
export async function setAgentModel(row: AgentRow, model: string, session?: string): Promise<Result> {
  const agent = await openAgent(row);
  if (session) await agent.sessions.update(session, { model: refOf(model) });
  await registry.setModel(row.id, model);
  return { ok: true };
}

export function relocateAgent(id: string, dir: string): Promise<Result> {
  return change(id, async () => {
    await registry.relocate(id, dir);
    failedConfigs.delete(id);
    return { ok: true };
  });
}

const configFailed = (id: string) => failedConfigs.has(id);

export function resetAgentConfig(row: AgentRow): Promise<Result> {
  return change(row.id, async () => {
    const config = failedConfigs.get(row.id);
    if (!config) return refuse("config_loads", "This agent's config is not what failed to load. Retry to see what did.");
    await freshConfig(row.dir, config);
    failedConfigs.delete(row.id);
    return { ok: true };
  });
}

export function removeAgent(id: string): Promise<Result> {
  return change(id, async () => {
    await registry.remove(id);
    failedConfigs.delete(id);
    return { ok: true };
  });
}

/** Whether any open agent has a conversation at work. */
export async function runsBusy(): Promise<boolean> {
  return (await runningSessions(await openedAgents())).length > 0;
}

/** Stops every run before a quit, and answers whether they all settled inside `within`. */
export async function stopAllRuns(within: number): Promise<boolean> {
  return stopRuns(await openedAgents(), within);
}

/** Release every instance's storage before the process ends. */
export async function closeAgents(): Promise<void> {
  const open = await openedAgents();
  opened.clear();
  await Promise.all(open.map(({ agent }) => agent.close()));
}
