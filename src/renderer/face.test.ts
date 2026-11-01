import assert from "node:assert/strict";
import { test } from "node:test";
import { faceOf } from "./face.ts";

const ready = { state: "ready" as const, outcomes: [], open: false };

test("an agent's face is what it most asks of the person: setup, then work, then an outcome, then being open", () => {
  assert.equal(faceOf(ready), "idle");
  assert.equal(faceOf({ ...ready, open: true }), "open");
  assert.equal(faceOf({ ...ready, outcomes: ["done"], open: true }), "done", "an outcome waiting beats being open");
  assert.equal(faceOf({ ...ready, outcomes: ["done", "failed"] }), "failed", "one failure among them is what it shows");
  assert.equal(faceOf({ ...ready, outcomes: ["failed"], doing: "tool" }), "tool", "work in flight beats an older outcome");
  assert.equal(faceOf({ ...ready, state: "missing_dir", doing: "thinking" }), "broken", "a setup problem beats everything");
  assert.equal(faceOf({ ...ready, state: "broken", outcomes: ["done"] }), "broken");
});
