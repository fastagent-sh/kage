import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AVATARS, avatar, DEFAULTS, network, proxyUrl, SettingsFile } from "./settings.ts";

const readSettings = (file: string) => new SettingsFile(file).read();

test("only a missing file is a first run; an unreadable one names itself", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kage-settings-"));
  const file = join(dir, "settings.json");
  assert.deepEqual(await readSettings(file), DEFAULTS);

  await writeFile(file, "{not json");
  await assert.rejects(readSettings(file), (error: Error) => error.message.startsWith(`${file}: `));
  await writeFile(file, JSON.stringify({ network: { mode: "manual", url: "ftp://x" } }));
  await assert.rejects(readSettings(file), /http:\/\/, https:\/\/ or socks5:\/\//);
  await writeFile(file, JSON.stringify({ network: { mode: "sometimes" } }));
  await assert.rejects(readSettings(file), /Unknown network mode: "sometimes"/);

  await writeFile(file, "{}");
  await new SettingsFile(file).change({ network: { mode: "manual", url: "socks5://127.0.0.1:7891" }, avatar: "moods" });
  assert.deepEqual(await readSettings(file), { network: { mode: "manual", url: "socks5://127.0.0.1:7891" }, avatar: "moods" });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).network.mode, "manual");
});

test("the avatar style is one kage draws; a file that names none has the default, one that names another is an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kage-settings-"));
  const file = join(dir, "settings.json");
  assert.equal(DEFAULTS.avatar, "gaze");
  await writeFile(file, JSON.stringify({ network: { mode: "off" } }));
  assert.deepEqual(await readSettings(file), { network: { mode: "off" }, avatar: "gaze" }, "never chosen is the default");
  await writeFile(file, JSON.stringify({ avatar: "sparkles" }));
  await assert.rejects(readSettings(file), (error: Error) => error.message === `${file}: Unknown avatar style: "sparkles"`);
  for (const style of AVATARS) assert.equal(avatar(style), style);
  assert.throws(() => avatar(undefined), /Unknown avatar style/);
});

test("a proxy URL is normalised to scheme and host, and anything else is refused", () => {
  assert.equal(proxyUrl(" http://127.0.0.1:7890/ "), "http://127.0.0.1:7890");
  assert.equal(proxyUrl("socks5://127.0.0.1:7891"), "socks5://127.0.0.1:7891");
  assert.equal(proxyUrl("http://proxy.corp:80"), "http://proxy.corp:80");
  assert.equal(proxyUrl("https://proxy.corp"), "https://proxy.corp:443");
  assert.equal(proxyUrl("socks5://proxy.corp"), "socks5://proxy.corp:1080");
  assert.throws(() => proxyUrl(""), /needs a URL/);
  assert.throws(() => proxyUrl("127.0.0.1:7890"), /http:\/\/, https:\/\/ or socks5:\/\/|Not a URL/);
  assert.deepEqual(network({ mode: "off" }), { mode: "off" });
  assert.throws(() => network({ mode: "manual" }), /needs a URL/);
});

test("changes go one at a time: two at once both land, a failed one leaves the file and the queue running", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "kage-settings-")), "settings.json");
  const settings = new SettingsFile(file);
  const order: string[] = [];
  await Promise.all([
    settings.change({ avatar: "clay" }, async () => void order.push("avatar")),
    settings.change({ network: { mode: "off" } }, async () => void order.push("network")),
  ]);
  assert.deepEqual(await settings.read(), { network: { mode: "off" }, avatar: "clay" }, "neither change lost the other");
  assert.deepEqual(order, ["avatar", "network"], "each change's follow-up runs in its own turn, in order");

  // A file that cannot be read may hold what the person meant: it is not overwritten.
  await writeFile(file, "{broken");
  await assert.rejects(settings.change({ avatar: "moods" }), (error: Error) => error.message.startsWith(`${file}: `));
  assert.equal(await readFile(file, "utf8"), "{broken");
  await writeFile(file, "{}");
  await settings.change({ avatar: "moods" });
  assert.equal((await settings.read()).avatar, "moods", "the next change still runs");
});
