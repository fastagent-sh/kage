import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../preload/index.ts";
import { rows } from "./sessions.ts";

const summary = (session: string, updatedAt?: number, preview?: string): SessionSummary => ({
  session,
  ...(updatedAt !== undefined && { updatedAt }),
  ...(preview !== undefined && { preview }),
});

test("rows keep the order FastAgent lists them in, labelled by the person's newest message", () => {
  const list = rows([summary("b", 2, "Deploy it"), summary("a", 1, "hi")]);
  assert.deepEqual(
    list.map((r) => [r.session, r.label]),
    [["b", "Deploy it"], ["a", "hi"]],
  );
});

test("a freshly minted session is shown before the runtime knows it", () => {
  const list = rows([summary("a", 1, "hi")], "new-id");
  assert.equal(list[0]?.session, "new-id");
  assert.equal(list[0]?.fresh, true);
  assert.equal(list.length, 2);
});

test("once the runtime reports it, the placeholder is gone", () => {
  const list = rows([summary("new-id", 5, "first message")], "new-id");
  assert.deepEqual(list, [{ session: "new-id", label: "first message", updatedAt: 5 }]);
});

test("an unsettled first turn remains selectable after starting another conversation", () => {
  const list = rows([], "new", ["running"]);
  assert.deepEqual(
    list.map((row) => row.session),
    ["new", "running"],
  );
  assert.equal(list[1]?.label, "Running conversation");
  assert.equal(rows([], "running", ["running"]).length, 1);
});

test("a row says whether it is running or holding unsent text", () => {
  const list = rows([summary("live", 9, "deploy"), summary("idle", 8, "notes")], undefined, [
    "live",
  ], ["idle"]);
  assert.deepEqual(
    list.map((row) => [row.session, row.running ?? false, row.draft ?? false]),
    [
      ["live", true, false],
      ["idle", false, true],
    ],
  );
});

test("a session nothing was said in is listed as a new conversation, and is FastAgent's, not one made here", () => {
  const [row] = rows([summary("4f1c-uuid")]);
  assert.equal(row?.label, "New conversation");
  assert.equal(row?.updatedAt, undefined);
  assert.equal(row?.fresh, undefined);
  assert.equal(rows([summary("old", 3)])[0]?.label, "Conversation", "one used, with nothing the person said in view, is not called new");
});
