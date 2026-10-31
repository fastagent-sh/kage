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

const POLL_MS = 50;

/**
 * Cancels every running session, and answers whether they all went idle inside `within`. A cancel that fails is
 * said and does not keep the others waiting.
 */
export async function stopRuns(agents: Opened[], within: number): Promise<boolean> {
  const byId = new Map(agents.map((opened) => [opened.id, opened.agent]));
  const running = await runningSessions(agents);
  const deadline = Date.now() + within;
  await Promise.all(
    running.map(({ agentId, session }) =>
      byId.get(agentId)!.sessions.cancel(session).catch((error: unknown) => {
        console.error(`duang: ${agentId}/${session} could not be stopped before quitting:`, error);
      }),
    ),
  );
  while (Date.now() < deadline) {
    if ((await runningSessions(agents)).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return (await runningSessions(agents)).length === 0;
}
