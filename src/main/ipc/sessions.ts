// Conversations: history, the live subscription each one has here, and the turns sent through it. This module
// owns that table and the in-flight sends, because quitting and a window's release need them too.
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { Entry, LocalAgent, Message } from "@fastagent-sh/fastagent";
import { agentRow, createSession, openAgent, withAgentRun } from "../agents.ts";
import { subscriptions, type Frame, type Listener } from "../follow.ts";
import { effortOf, offered } from "../models.ts";
import { syncCommandProxy } from "../proxy.ts";
import { refusal, refuse, send, sends } from "../send.ts";
import { readEntries } from "../session-list.ts";

/** These throw: a malformed session id is a bug in this app, not something a person can act on. */
export function requireSession(session: string): void {
  if (typeof session !== "string" || !session) throw new Error("Invalid session id");
}

async function agentOf(agentId: string) {
  return openAgent(await agentRow(agentId));
}

const sessions = subscriptions(async (agentId, session, after, signal) =>
  (await agentOf(agentId)).sessions.events(session, { after, signal }),
);
const inFlight = sends();

const listener = (sender: WebContents): Listener => ({
  id: sender.id,
  post: (frame: Frame) => {
    if (!sender.isDestroyed()) sender.send("session:event", frame);
  },
});

/** A window that is closing or reloading keeps its runs; it just stops hearing them. */
export const closeWindow = (senderId: number) => sessions.closeWindow(senderId);
/** Cutting an agent's subscriptions is invisible to the window unless each one says why it ended. */
export const endAgent = (agentId: string, reason: string) => sessions.endAgent(agentId, reason);
export const releaseAgent = (agentId: string) => sessions.releaseAgent(agentId);
/** From now on a message is refused rather than started and cut. */
export const quitSends = () => inFlight.quit();

// How the newest message ended says what a turn that left no answer was: refused, failed or stopped.
async function lastMessageOf(agent: LocalAgent, sessionId: string, entries: Entry[]): Promise<Message | undefined> {
  const user = entries.findLast((entry) => entry.kind === "user");
  const messageId = (user?.data as { messageId?: unknown } | undefined)?.messageId;
  if (typeof messageId !== "string") return undefined;
  return agent.messages.get({ sessionId, messageId });
}

export function registerSessions(): void {
  ipcMain.handle("session:create", async (_e, id: string) => createSession(await agentRow(id)));
  ipcMain.handle("session:state", async (_e, id: string, session: string) => {
    requireSession(session);
    return (await agentOf(id)).sessions.get(session);
  });
  ipcMain.handle("session:setThinking", async (_e, id: string, session: string, level: string) => {
    requireSession(session);
    if (typeof level !== "string") throw new Error("Thinking level must be a string");
    return refusal(async () => {
      const agent = await agentOf(id);
      const model = await effortOf(agent, session, (await agentRow(id)).model);
      const supported = model?.thinkingLevels.find((candidate) => candidate === level);
      if (!supported) return refuse("unsupported_level", `${model?.spec ?? "This conversation's model"} does not support the ${level} effort.`, false);
      await agent.sessions.update(session, { thinkingLevel: supported });
      return { ok: true };
    });
  });
  ipcMain.handle("session:close", (e, subscription: string) => sessions.close(e.sender.id, subscription));
  ipcMain.handle("session:entries", async (_e, id: string, session: string) => {
    requireSession(session);
    return readEntries(await agentOf(id), session);
  });
  ipcMain.handle("session:open", async (e, id: string, session: string, subscription: string) => {
    requireSession(session);
    const agent = await agentOf(id);
    const entries = await readEntries(agent, session);
    // From the last entry held: what landed since is replayed, so nothing falls between the read and the stream.
    await sessions.open(listener(e.sender), id, session, subscription, entries.at(-1)?.id ?? "start");
    try {
      return { entries, session: await agent.sessions.get(session), lastMessage: await lastMessageOf(agent, session, entries) };
    } catch (error) {
      // The window reports this open as failed and holds nothing to close, so the subscription it would feed ends here.
      sessions.close(e.sender.id, subscription);
      throw error;
    }
  });
  ipcMain.handle("session:send", async (_e: IpcMainInvokeEvent, id: string, session: string, text: string) => {
    requireSession(session);
    if (typeof text !== "string" || !text.trim()) throw new Error("Message must not be empty");
    // Held before the first await: a Stop sent right after this message must find it.
    return inFlight.hold(id, session, async (stopped) => {
      // The agent's commands spawn during this run; they get the route as it is now.
      await syncCommandProxy();
      const row = await agentRow(id);
      return withAgentRun(row, (agent) => send(agent, session, text, stopped, (model) => offered(agent, model), row.model));
    });
  });
  ipcMain.handle("session:abort", async (_e, id: string, session: string) => {
    requireSession(session);
    return inFlight.stop(id, session, async () => (await agentOf(id)).sessions.cancel(session));
  });
}
