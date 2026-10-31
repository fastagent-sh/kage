import type { SessionSummary } from "../preload/index.ts";

export interface Row {
  session: string;
  label: string;
  updatedAt?: number;
  // Not in the agent's list yet: made a moment ago, or running somewhere this window only just heard of.
  fresh?: boolean;
  running?: boolean;
  draft?: boolean;
  unseen?: "done" | "failed";
}

export function rows(
  summaries: SessionSummary[],
  selected?: string,
  running: string[] = [],
  drafts: string[] = [],
  unseen: Record<string, "done" | "failed"> = {},
): Row[] {
  const mark = <T extends { session: string }>(row: T) => ({
    ...row,
    ...(running.includes(row.session) ? { running: true } : {}),
    ...(drafts.includes(row.session) ? { draft: true } : {}),
    ...(unseen[row.session] ? { unseen: unseen[row.session] } : {}),
  });
  // In the order FastAgent lists them: most recently active first.
  const known = summaries.map((s) =>
    mark({
      session: s.session,
      // Nothing said in it yet, or nothing the person said within the window FastAgent was asked about.
      label: s.preview ?? (s.updatedAt === undefined ? "New conversation" : "Conversation"),
      ...(s.updatedAt !== undefined && { updatedAt: s.updatedAt }),
    }),
  );
  const local = [...new Set([...(selected ? [selected] : []), ...running, ...drafts])]
    .filter((session) => !known.some((row) => row.session === session))
    .map((session) =>
      mark({
        session,
        label: running.includes(session) ? "Running conversation" : "New conversation",
        fresh: true,
      }),
    );
  return [...local, ...known];
}
