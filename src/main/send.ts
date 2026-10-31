import { AgentError, type Agent } from "@fastagent-sh/fastagent";
import { MODEL_UNAVAILABLE_CODE, STOPPED_CODE } from "../shared/refusals.ts";
import type { Result, Sent } from "../shared/result.ts";
import { refOf, specOf } from "./models.ts";

export const refuse = (code: string, message: string, retryable = true): Result<never> => ({
  ok: false,
  error: { code, message, retryable },
});

const stoppedBeforeStart = refuse(STOPPED_CODE, "Stopped before the message was sent");

const unavailable = (model: string) =>
  refuse(
    MODEL_UNAVAILABLE_CODE,
    `${model} cannot run: its provider is not connected, or the model is not offered to it. Connect the provider, or choose another model for this conversation.`,
  );

/** A refusal FastAgent reports as an error is a refusal here too, with its words and its `retryable`. */
export async function refusal<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AgentError) return refuse(error.code, error.message, error.retryable);
    throw error;
  }
}

// `stopped` is checked right before each hand-off, so a Stop that came first makes no call. A message goes only to
// a model the picker would offer; anything else is refused before anything is recorded. A conversation with no
// model of its own is given the agent's default here, so what runs is what was shown and is recorded with it.
// A busy conversation takes the message as a steer (an idle one starts on it), and what becomes of it is
// reported by the conversation's own events.
export function send(
  agent: Agent,
  sessionId: string,
  text: string,
  stopped: () => boolean,
  offered: (model: string) => Promise<boolean>,
  agentDefault?: string,
): Promise<Sent> {
  return refusal(async () => {
    if (stopped()) return stoppedBeforeStart;
    const session = await agent.sessions.get(sessionId);
    const spec =
      (session.model && specOf(session.model)) ?? agentDefault ?? ((await agent.info()).defaultModel && specOf((await agent.info()).defaultModel!));
    if (spec && !(await offered(spec))) return unavailable(spec);
    if (stopped()) return stoppedBeforeStart;
    if (!session.model && agentDefault) await agent.sessions.update(sessionId, { model: refOf(agentDefault) });
    const message = await agent.messages.send({ sessionId, content: text, whenBusy: "steer" });
    if (!stopped()) return { ok: true, messageId: message.id };
    // The Stop came while the message was being recorded, so it stops what the Stop meant to stop. The message is
    // recorded either way: a cancel FastAgent refuses is reported beside it, not as a send that did not happen.
    try {
      await agent.sessions.cancel(sessionId);
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      return { ok: true, messageId: message.id, stopError: { code: error.code, message: error.message, retryable: error.retryable } };
    }
    return { ok: true, messageId: message.id };
  });
}

// Before a send reaches the agent there is nothing to cancel, so a Stop is recorded here and the send gives up.
export function sends() {
  type Ticket = { stopped: boolean };
  type Held = Set<Ticket>;
  const held = new Map<string, Held>();
  const keyOf = (agentId: string, session: string) => `${agentId}/${session}`;
  let quitting = false;
  return {
    hold<T>(agentId: string, session: string, run: (stopped: () => boolean) => Promise<Result<T>>): Promise<Result<T>> {
      if (quitting) return Promise.resolve(refuse("quitting", "duang is quitting: the message was not sent"));
      const key = keyOf(agentId, session);
      const ticket: Ticket = { stopped: false };
      const tickets = held.get(key) ?? new Set();
      held.set(key, tickets);
      tickets.add(ticket);
      return run(() => ticket.stopped).finally(() => {
        tickets.delete(ticket);
        if (tickets.size === 0 && held.get(key) === tickets) held.delete(key);
      });
    },
    /** Stops what is on its way, then what the agent is doing. */
    async stop(agentId: string, session: string, cancel: () => Promise<unknown>): Promise<Result> {
      for (const ticket of held.get(keyOf(agentId, session)) ?? []) ticket.stopped = true;
      return refusal(async () => {
        await cancel();
        return { ok: true };
      });
    },
    /** From now on a message is refused rather than started and cut. */
    quit() {
      quitting = true;
    },
  };
}
