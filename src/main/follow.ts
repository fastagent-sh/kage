// A subscription is one window's view of one session's events. FastAgent replays the entries after a cursor and then
// goes live, so a subscription that ends can start again without a gap. No Electron import, so it is testable.
import type { SessionEvent } from "@fastagent-sh/fastagent";

export type Frame = { agentId: string; session: string; subscription: string } & (
  | { event: SessionEvent; ended?: never }
  | { event?: never; ended: { reason: string; why: Ending } }
);
// let_go: the stream finished by itself (the runtime closed it: listen again). ended: duang ended it. failed: it broke.
export type Ending = "let_go" | "ended" | "failed";
export interface Listener {
  id: number;
  post(frame: Frame): void;
}

export type EventSource = (agentId: string, session: string, after: string, signal: AbortSignal) => Promise<AsyncIterable<SessionEvent>>;

export function subscriptions(events: EventSource) {
  type Slot = { window: number; agentId: string; abort: AbortController; end(reason: string): void };
  const slots = new Map<string, Slot>();
  const stop = (key: string) => {
    const slot = slots.get(key);
    slots.delete(key);
    slot?.abort.abort();
  };
  return {
    // `after` is the last entry the window already holds, or "start" when it holds none.
    async open(window: Listener, agentId: string, session: string, subscription: string, after: string): Promise<void> {
      const key = `${window.id}/${subscription}`;
      stop(key);
      const abort = new AbortController();
      const post = (frame: { event: SessionEvent } | { ended: { reason: string; why: Ending } }) => {
        if (slots.get(key) === slot) window.post({ agentId, session, subscription, ...frame } as Frame);
      };
      // In the table before the stream opens, which is what the checks below compare against.
      const slot: Slot = {
        window: window.id,
        agentId,
        abort,
        end: (reason) => post({ ended: { reason, why: "ended" } }),
      };
      slots.set(key, slot);
      let stream: AsyncIterable<SessionEvent>;
      try {
        stream = await events(agentId, session, after, abort.signal);
        if (slots.get(key) !== slot) throw new Error("Conversation open was superseded");
      } catch (error) {
        if (slots.get(key) === slot) stop(key);
        throw error;
      }
      void (async () => {
        let ending: { reason: string; why: Ending } = { reason: "This conversation stopped receiving updates", why: "let_go" };
        try {
          for await (const event of stream) {
            if (event.type === "stream_error") {
              ending = { reason: event.error.message, why: "failed" };
              break;
            }
            post({ event });
          }
        } catch (error) {
          ending = { reason: String(error), why: "failed" };
        }
        if (slots.get(key) !== slot) return;
        post({ ended: ending });
        slots.delete(key);
      })();
    },
    close: (window: number, subscription: string) => stop(`${window}/${subscription}`),
    // The window's runs outlive it.
    closeWindow(window: number) {
      for (const [key, slot] of slots) if (slot.window === window) stop(key);
    },
    /** Cutting an agent's subscriptions is invisible to the window unless each one says why it ended. */
    endAgent(agentId: string, reason: string) {
      for (const [key, slot] of slots)
        if (slot.agentId === agentId) {
          slot.end(reason);
          stop(key);
        }
    },
  };
}
