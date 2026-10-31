import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent, Entry } from "@fastagent-sh/fastagent";
import { readEntries, summaries } from "./session-list.ts";

const user = (id: number, text: string): Entry =>
  ({ id: `e${id}`, timestamp: id * 1000, kind: "user", data: { content: [{ type: "text", text }] } }) as Entry;
const reply = (id: number): Entry => ({ id: `e${id}`, timestamp: id * 1000, kind: "assistant", data: { text: "ok" } }) as Entry;

// FastAgent's paging: the newest page without a cursor, `prev` for the page before it, oldest first inside a page.
function fake(history: Record<string, Entry[]>, order = Object.keys(history), listPage = 2) {
  const reads: string[] = [];
  const reading = { now: 0, most: 0 };
  const agent = {
    sessions: {
      list: async ({ after }: { after?: string } = {}) => {
        const start = after ? Number(after) : 0;
        const data = order.slice(start, start + listPage).map((id) => ({ id }));
        return { data, ...(start + listPage < order.length && { next: String(start + listPage) }) };
      },
      entries: async (id: string, { before, limit = 100 }: { before?: string; limit?: number } = {}) => {
        reads.push(id);
        reading.most = Math.max(reading.most, ++reading.now);
        await new Promise((resolve) => setImmediate(resolve));
        reading.now--;
        const all = history[id] ?? [];
        if (!all.length && !(id in history)) throw new Error(`No session ${id}`);
        const end = before === undefined ? all.length : Number(before);
        const start = Math.max(0, end - limit);
        return { data: all.slice(start, end), ...(start > 0 && { prev: String(start) }) };
      },
    },
  } as unknown as Agent;
  return { agent, reads, reading };
}

test("a session is titled by the newest message the person sent, and timed by its newest entry", async () => {
  const { agent } = fake({
    a: [user(1, "first question"), reply(2), user(3, "the   newest\nquestion"), reply(4)],
    b: [],
  });
  assert.deepEqual(await summaries(agent), [
    { session: "a", updatedAt: 4000, preview: "the newest question" },
    { session: "b" },
  ]);
});

test("a title longer than a row is cut, an image is not a word, and the lookback ends", async () => {
  const long = "x".repeat(300);
  const { agent } = fake({
    long: [user(1, long)],
    image: [{ id: "e1", timestamp: 1, kind: "user", data: { content: [{ type: "image", mimeType: "image/png", ref: "r" }] } } as Entry],
    // More than the five pages searched have passed since anyone spoke: it is listed, with no title.
    run: [user(1, "start the job"), ...Array.from({ length: 600 }, (_, n) => reply(n + 2))],
  });
  const [cut, image, run] = await summaries(agent);
  assert.equal(cut!.preview!.length, 120);
  assert.ok(cut!.preview!.endsWith("…"));
  assert.equal(image!.preview, "[image]");
  assert.equal(run!.preview, undefined);
  assert.equal(run!.updatedAt, 601_000);
});

test("every page of the list is read, in FastAgent's order, one read of entries per session", async () => {
  const history = Object.fromEntries(["a", "b", "c", "d", "e"].map((id, n) => [id, [user(n + 1, `say ${id}`)]]));
  const { agent, reads } = fake(history, ["c", "a", "e", "b", "d"]);
  assert.deepEqual((await summaries(agent)).map((row) => row.session), ["c", "a", "e", "b", "d"]);
  assert.deepEqual([...reads].sort(), ["a", "b", "c", "d", "e"]);
});

test("a session that cannot be read fails the list instead of dropping its row", async () => {
  const { agent } = fake({ a: [user(1, "hi")] }, ["a", "gone"]);
  await assert.rejects(summaries(agent), /No session gone/);
});

test("the whole history comes back oldest first, whichever page it was on", async () => {
  const entries = Array.from({ length: 1200 }, (_, n) => reply(n + 1));
  const { agent } = fake({ s: entries });
  const read = await readEntries(agent, "s");
  assert.equal(read.length, 1200);
  assert.deepEqual(read.map((entry) => entry.id), entries.map((entry) => entry.id));
});

test("only a few sessions are read at once, and the order of the list survives", async () => {
  const ids = Array.from({ length: 30 }, (_, n) => `s${n}`);
  const { agent, reading } = fake(Object.fromEntries(ids.map((id, n) => [id, [user(n + 1, `say ${id}`)]])), ids, 10);
  assert.deepEqual((await summaries(agent)).map((row) => row.session), ids);
  assert.equal(reading.most, 8);
});
