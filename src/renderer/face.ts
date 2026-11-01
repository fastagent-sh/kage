import type { AgentState } from "./store.ts";
import type { Activity } from "./transcript.ts";

export type Face =
  | "idle"
  | "open"
  | "thinking"
  | "tool"
  | "answering"
  | "done"
  | "failed"
  | "broken";

export const WORKING: readonly Face[] = ["thinking", "tool", "answering"];

export function faceOf({
  state,
  doing,
  outcomes,
  open,
}: {
  state: AgentState;
  doing?: Activity;
  outcomes: readonly ("done" | "failed")[];
  open: boolean;
}): Face {
  if (state === "broken" || state === "missing_dir") return "broken";
  if (doing) return doing;
  if (outcomes.includes("failed")) return "failed";
  if (outcomes.length) return "done";
  return open ? "open" : "idle";
}
