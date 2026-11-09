import assert from "node:assert/strict";
import { test } from "node:test";
import { createDraftStorage } from "./drafts.ts";

function storage(values = new Map<string, string>()) {
  let writes = 0;
  let failRead = false;
  let failWrite: string | undefined;
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        if (failRead) throw new Error("storage cannot be read");
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        writes++;
        if (failWrite === key) throw new Error("storage full");
        values.set(key, value);
      },
    },
  });
  return {
    values,
    writes: () => writes,
    readFails: () => { failRead = true; },
    writeFails: (key?: string) => { failWrite = key; },
    restore() {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
}

test("a failed quarantine never permits overwriting the original drafts", (t) => {
  const mock = storage(new Map([["kage.drafts", "{original text"]]));
  t.after(mock.restore);
  mock.writeFails("kage.drafts.unreadable");
  const drafts = createDraftStorage();
  assert.deepEqual(drafts.entries, []);
  assert.match(drafts.save([["a/s", "new text"]]) ?? "", /storage full/);
  assert.equal(mock.values.get("kage.drafts"), "{original text");
  assert.equal(mock.values.has("kage.drafts.unreadable"), false);
});

test("drafts that cannot be read are protected until a reload", (t) => {
  const mock = storage(new Map([["kage.drafts", '[["a/s","old text"]]']]));
  t.after(mock.restore);
  mock.readFails();
  const drafts = createDraftStorage();
  assert.match(drafts.save([["a/s", "new text"]]) ?? "", /storage cannot be read/);
  assert.equal(mock.writes(), 0);
});

test("only a successful write suppresses saving the same drafts again", (t) => {
  const mock = storage();
  t.after(mock.restore);
  const drafts = createDraftStorage();
  mock.writeFails("kage.drafts");
  assert.match(drafts.save([["a/s", "keep me"]]) ?? "", /storage full/);
  mock.writeFails();
  assert.equal(drafts.save([["a/s", "keep me"]]), undefined);
  assert.equal(mock.values.get("kage.drafts"), '[["a/s","keep me"]]');
  const writes = mock.writes();
  assert.equal(drafts.save([["a/s", "keep me"]]), undefined);
  assert.equal(mock.writes(), writes);
});

test("invalid drafts are preserved before new ones are saved", (t) => {
  const mock = storage(new Map([["kage.drafts", "{}"]]));
  t.after(mock.restore);
  const drafts = createDraftStorage();
  assert.match(drafts.save([["a/s", "new text"]]) ?? "", /kage.drafts.unreadable/);
  assert.equal(mock.values.get("kage.drafts.unreadable"), "{}");
  assert.equal(mock.values.get("kage.drafts"), '[["a/s","new text"]]');
  const reloaded = createDraftStorage();
  assert.deepEqual(reloaded.entries, [["a/s", "new text"]]);
  assert.equal(reloaded.save(reloaded.entries), undefined);
});
