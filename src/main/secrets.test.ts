import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SecretStore } from "./secrets.ts";

test("secrets are kept per agent in an owner-only file, survive a restart, and an unreadable file is never replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "kage-secrets-"));
  try {
    const file = join(root, "secrets.json");
    const store = new SecretStore(file);
    assert.deepEqual(await store.get("a"), {});
    await Promise.all([store.set("a", "TOKEN", "1"), store.set("a", "OTHER", "2"), store.set("b", "TOKEN", "3")]);
    assert.deepEqual(await new SecretStore(file).get("a"), { TOKEN: "1", OTHER: "2" });
    assert.equal((await stat(file)).mode & 0o777, 0o600);

    await store.remove("a", "OTHER");
    assert.deepEqual(await store.get("a"), { TOKEN: "1" });
    await store.removeAgent("b");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { a: { TOKEN: "1" } });

    await writeFile(file, "{not json");
    await assert.rejects(store.get("a"), /secrets\.json/);
    await assert.rejects(store.set("a", "NEW", "x"), /secrets\.json/);
    assert.equal(await readFile(file, "utf8"), "{not json", "a failed read never rewrites the file");
    await writeFile(file, JSON.stringify({ a: { TOKEN: 1 } }));
    await assert.rejects(store.get("a"), /invalid secrets file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
