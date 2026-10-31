import type { Agent } from "@fastagent-sh/fastagent";

type Opened = { id: string; agent: Agent };

/** The running sessions of every agent. A status this app does not know counts as running (FastAgent's rule). */
export async function runningSessions(agents: Opened[]): Promise<{ agentId: string; session: string }[]> {
  const running: { agentId: string; session: string }[] = [];
  for (const { id, agent } of agents)
    for (let page = await agent.sessions.list(); ; page = await agent.sessions.list({ after: page.next })) {
      for (const session of page.data) if (session.status !== "idle") running.push({ agentId: id, session: session.id });
      if (!page.next) break;
    }
  return running;
}

/**
 * Cancels every running session. The stop is recorded before this resolves and holds after a restart, which is what
 * keeps a message from being answered at the next launch; closing the agent is what waits for its work to end. A
 * cancel that fails is said and does not keep the others waiting.
 */
export async function stopRuns(agents: Opened[]): Promise<void> {
  const byId = new Map(agents.map((opened) => [opened.id, opened.agent]));
  const running = await runningSessions(agents);
  await Promise.all(
    running.map(({ agentId, session }) =>
      byId.get(agentId)!.sessions.cancel(session).catch((error: unknown) => {
        console.error(`duang: ${agentId}/${session} could not be stopped before quitting:`, error);
      }),
    ),
  );
}
