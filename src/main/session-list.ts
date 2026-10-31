import type { Agent, Entry } from "@fastagent-sh/fastagent";
import { textOf } from "../shared/entries.ts";

/** A conversation-list row. FastAgent's session carries neither a time nor a title, so both come from its entries. */
export interface SessionSummary {
  session: string;
  /** The time of the newest entry; absent for a session nothing was said in. */
  updatedAt?: number;
  /** The newest message the person sent, one line. */
  preview?: string;
}

// A title is the newest message the person sent; a session that has run for hundreds of entries since has none to quote.
const PAGE = 100;
const PAGES = 5;
const PREVIEW_CHARS = 120;

const oneLine = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
};

async function summarize(agent: Agent, session: string): Promise<SessionSummary> {
  let page = await agent.sessions.entries(session, { limit: PAGE });
  const newest = page.data.at(-1);
  for (let pages = 1; ; pages++) {
    const user = page.data.findLast((entry: Entry) => entry.kind === "user");
    if (user) {
      const preview = oneLine(textOf((user.data as { content?: unknown }).content));
      return { session, updatedAt: newest!.timestamp, ...(preview && { preview }) };
    }
    if (!page.prev || pages === PAGES) break;
    page = await agent.sessions.entries(session, { before: page.prev, limit: PAGE });
  }
  return newest ? { session, updatedAt: newest.timestamp } : { session };
}

/** Every session of the agent, most recently active first. A session that cannot be read fails the whole list. */
export async function summaries(agent: Agent): Promise<SessionSummary[]> {
  const sessions: string[] = [];
  for (let page = await agent.sessions.list(); ; page = await agent.sessions.list({ after: page.next })) {
    sessions.push(...page.data.map((session) => session.id));
    if (!page.next) break;
  }
  return Promise.all(sessions.map((session) => summarize(agent, session)));
}

/** The whole history, oldest first. */
export async function readEntries(agent: Agent, session: string): Promise<Entry[]> {
  const pages: Entry[][] = [];
  for (let page = await agent.sessions.entries(session, { limit: 500 }); ; page = await agent.sessions.entries(session, { before: page.prev, limit: 500 })) {
    pages.unshift(page.data);
    if (!page.prev) break;
  }
  return pages.flat();
}
