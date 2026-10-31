import assert from "node:assert/strict";
import { test } from "node:test";
import { complete, completionQuery, matches } from "./commands.ts";

const commands = [
  { name: "model" },
  { name: "compact" },
  { name: "commit", description: "write a commit" },
];

test("a bare slash offers everything; typing narrows it", () => {
  assert.equal(completionQuery("/"), "");
  assert.deepEqual(
    matches(commands, completionQuery("/co")!).map((c) => c.name),
    ["compact", "commit"],
  );
});

test("completion stops at the first space — the rest is pi's to read", () => {
  assert.equal(completionQuery("/commit fix the parser"), undefined);
  assert.equal(completionQuery("/commit "), undefined);
});

test("a line that does not start with a slash is not a command", () => {
  assert.equal(completionQuery("hello /model"), undefined);
  assert.equal(completionQuery(""), undefined);
});

test("accepting a name leaves the cursor where arguments go, in the spelling FastAgent expands", () => {
  assert.equal(complete({ name: "commit" }), "/commit ");
  // FastAgent names a skill's command `skill:<name>`; a bare `/weather` would reach the model as plain text.
  assert.equal(complete({ name: "skill:weather" }), "/skill:weather ");
});

test("a skill is found by the name it is typed with, and by its own name", () => {
  const skills = [{ name: "skill:weather" }, { name: "wire" }];
  assert.deepEqual(matches(skills, "skill:w").map((c) => c.name), ["skill:weather"]);
  assert.deepEqual(matches(skills, "w").map((c) => c.name), ["skill:weather", "wire"]);
});
