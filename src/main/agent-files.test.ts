import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { baseEnv, openAgent, type AgentDefinition } from "@fastagent-sh/fastagent";
import {
  addFolderToAgent,
  agentModel,
  AgentRegistry,
  checkSecret,
  createNewAgent,
  failingConfig,
  freshConfig,
  inspectAgentDir,
  instanceConfigPath,
  listFolders,
  MissingDirError,
  removeFolderFromAgent,
  requireFolder,
  resolveAgentPath,
  setAgentModelInConfig,
} from "./agent-files.ts";

const repository = join(import.meta.dirname, "..", "..");

async function builtProgram(): Promise<AgentDefinition> {
  const build = spawnSync(join(repository, "node_modules", ".bin", "fastagent"), ["build", "program"], { cwd: repository, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  return (await import(pathToFileURL(join(repository, "program", "dist", "index.js")).href)).default;
}

const program = await builtProgram();

const openInstance = (dir: string, secrets: Record<string, string> = {}) =>
  openAgent(program, { root: dir, config: instanceConfigPath(dir), secrets, env: baseEnv(process.env), offline: true });

test("registry serializes writes in one process, survives restart and deduplicates real paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "kage-registry-"));
  try {
    const file = join(root, "data", "agents.json");
    const registry = new AgentRegistry(file);
    const a = join(root, "a"),
      b = join(root, "b"),
      alias = join(root, "alias");
    await Promise.all([mkdir(a), mkdir(b)]);
    await symlink(a, alias);
    assert.deepEqual(await registry.list(), []);
    const [first, second] = await Promise.all([registry.add(a), registry.add(b)]);
    assert.equal((await registry.add(alias)).id, first.id);
    await Promise.all([
      registry.rename(first.id, "Reviewer"),
      registry.remove(second.id),
    ]);
    await assert.rejects(registry.rename(second.id, "gone"), /unknown agent/);
    const restarted = new AgentRegistry(file);
    assert.deepEqual(await restarted.list(), [{ ...first, name: "Reviewer" }]);
    assert.deepEqual(await readdir(join(root, "data")), ["agents.json"]);
    await restarted.remove(first.id);
    assert.deepEqual(await restarted.list(), []);
    assert.deepEqual(await readdir(a), [], "removal leaves the project alone");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("each agent has a colour: the lowest one free, kept for its life, reused once it is free again", async () => {
  const root = await mkdtemp(join(tmpdir(), "kage-registry-"));
  try {
    const registry = new AgentRegistry(join(root, "agents.json"));
    const dirs = await Promise.all(["a", "b", "c", "d"].map(async (name) => {
      await mkdir(join(root, name));
      return join(root, name);
    }));
    const [a, b, c] = [await registry.add(dirs[0]!), await registry.add(dirs[1]!), await registry.add(dirs[2]!)];
    assert.deepEqual([a.colour, b.colour, c.colour], [0, 1, 2], "no two agents share one while the palette lasts");
    await registry.rename(b.id, "Renamed");
    assert.equal((await registry.list()).find((row) => row.id === b.id)!.colour, 1, "a rename does not recolour it");
    await registry.remove(b.id);
    assert.equal((await registry.add(dirs[3]!)).colour, 1, "a removed agent's colour is the next one's");
    assert.equal((await registry.list()).find((row) => row.id === a.id)!.colour, 0, "and the others keep theirs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every row names its colour, a whole number from zero; one without it is an invalid registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "kage-registry-"));
  try {
    const file = join(root, "agents.json");
    for (const colour of [undefined, -1, 1.5, "3", null]) {
      const stored = JSON.stringify([{ id: "x", name: "X", dir: "/tmp/x", ...(colour === undefined ? {} : { colour }) }]);
      await writeFile(file, stored);
      await assert.rejects(new AgentRegistry(file).list(), /invalid agent registry/, `colour ${JSON.stringify(colour)}`);
      assert.equal(await readFile(file, "utf8"), stored, "and the file is left as it was");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid or unreadable registry fails visibly and is never replaced with an empty list", async () => {
  const root = await mkdtemp(join(tmpdir(), "kage-registry-"));
  try {
    const file = join(root, "agents.json");
    const registry = new AgentRegistry(file);
    for (const corrupt of ["{broken", "{}", '[{"id":"a","name":5,"dir":"/tmp"}]']) {
      await writeFile(file, corrupt);
      await assert.rejects(registry.list(), (error: Error) => error.message.startsWith(`${file}: `));
      await assert.rejects(registry.add(root));
      assert.equal(await readFile(file, "utf8"), corrupt);
    }
    await rm(file);
    await mkdir(file);
    await assert.rejects(registry.list());
    await rm(file, { recursive: true });
    assert.equal(
      (await registry.add(root)).dir,
      await realpath(root),
      "a failed write does not poison the write queue",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creating an agent places it in ~/Agents/<slug>, binds its folders, numbers collisions, and refuses invalid content without leaving files", async () => {
  const root = await mkdtemp(join(tmpdir(), "kage-create-"));
  try {
    const agentsDir = join(root, "Agents");
    const registry = new AgentRegistry(join(root, "agents.json"));
    const tally = join(root, "tally");
    const handbook = join(root, "handbook");
    await Promise.all([mkdir(join(tally, "handbook"), { recursive: true }), mkdir(handbook)]);
    await writeFile(join(tally, "index.ts"), "export const n = 1;\n");
    await writeFile(join(tally, "handbook", "guide.md"), "shadow\n");
    await writeFile(join(handbook, "guide.md"), "real handbook\n");

    const first = await createNewAgent({ name: "Reviewer", folders: [tally, handbook], root: agentsDir, registry });
    assert.equal(first.name, "Reviewer");
    assert.equal(first.dir, join(await realpath(agentsDir), "Reviewer"));
    assert.equal(await readFile(join(first.dir, ".gitignore"), "utf8"), ".state\n");
    assert.equal(await readFile(join(first.dir, "AGENTS.md"), "utf8"), "# Reviewer\n");
    assert.deepEqual(await readdir(join(first.dir, "skills")), [".gitkeep"]);
    assert.deepEqual(await readdir(join(first.dir, "prompts")), [".gitkeep"]);
    assert.equal(JSON.parse(await readFile(instanceConfigPath(first.dir), "utf8")).name, "Reviewer");
    const listed = await listFolders(first.dir);
    assert.deepEqual(
      listed.map(({ name, location }) => [name, location]),
      [
        ["tally", await realpath(tally)],
        ["handbook", await realpath(handbook)],
      ],
    );
    // Relative paths inside bound folders resolve through resolveAgentPath, preferring explicit <name>/ prefixes.
    assert.equal(await resolveAgentPath(first.dir, "index.ts", root), await realpath(join(tally, "index.ts")));
    assert.equal(await resolveAgentPath(first.dir, "tally/index.ts", root), await realpath(join(tally, "index.ts")));
    assert.equal(await resolveAgentPath(first.dir, "handbook/guide.md", root), await realpath(join(handbook, "guide.md")));

    // Same name gets -2, and a name with / or .. never escapes ~/Agents/.
    const second = await createNewAgent({ name: "Reviewer", folders: [], root: agentsDir, registry });
    assert.equal(second.dir, join(await realpath(agentsDir), "Reviewer-2"));
    const escaped = await createNewAgent({ name: "../../outside", folders: [], root: agentsDir, registry });
    assert.equal(escaped.dir, join(await realpath(agentsDir), "outside"));
    await registry.rename(first.id, "Renamed Reviewer");
    assert.equal((await registry.list()).find((row) => row.id === first.id)?.dir, first.dir, "rename leaves the directory");

    // Adding and removing folders on an existing agent updates its bindings and leaves the folders on disk untouched.
    const otherTally = join(root, "other", "tally");
    await mkdir(otherTally, { recursive: true });
    const added = await addFolderToAgent(second.dir, tally);
    assert.deepEqual(added, [{ name: "tally", location: await realpath(tally) }]);
    await assert.rejects(
      addFolderToAgent(second.dir, otherTally),
      /already has content named "tally"/,
    );
    const afterRemove = await removeFolderFromAgent(second.dir, "tally");
    assert.deepEqual(afterRemove, []);
    assert.equal(await readFile(join(tally, "index.ts"), "utf8"), "export const n = 1;\n");

    // Refused declarations (duplicate folder name, or nesting around the agent directory) leave no directory.
    await assert.rejects(
      createNewAgent({ name: "Duplicate", folders: [tally, otherTally], root: agentsDir, registry }),
      /already has content named "tally"/,
    );
    await assert.rejects(
      createNewAgent({ name: "Nested", folders: [agentsDir], root: agentsDir, registry }),
      /contains the agent directory/,
    );
    assert.deepEqual((await readdir(agentsDir)).sort(), ["Reviewer", "Reviewer-2", "outside"].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an agent's default model is the instance config's, kept beside the folders it edits and read by FastAgent as its default", async () => {
  const root = await mkdtemp(join(tmpdir(), "kage-model-"));
  try {
    const registry = new AgentRegistry(join(root, "agents.json"));
    const project = join(root, "project");
    await mkdir(project);
    const agent = await createNewAgent({ name: "Modeled", folders: [], root: join(root, "Agents"), registry });
    assert.equal(await agentModel(agent.dir), undefined);
    await Promise.all([setAgentModelInConfig(agent.dir, "openai/gpt-4o-mini"), addFolderToAgent(agent.dir, project)]);
    assert.equal(await agentModel(agent.dir), "openai/gpt-4o-mini");
    assert.equal((await listFolders(agent.dir)).length, 1, "a model edit does not lose a folder edit made at once");
    await setAgentModelInConfig(agent.dir, "openai/gpt-4o");
    assert.equal((await listFolders(agent.dir)).length, 1, "nor the other way round");
    const opened = await openInstance(agent.dir);
    try {
      assert.deepEqual((await opened.info()).defaultModel, { provider: "openai", modelId: "gpt-4o" });
    } finally {
      await opened.close();
    }
    await writeFile(instanceConfigPath(agent.dir), JSON.stringify({ name: "x", model: 3 }));
    await assert.rejects(agentModel(agent.dir), /"model" must be a string/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh config replaces only the agent's own, keeps the old one beside it, never over a copy, and loads", async () => {
  const root = await mkdtemp(join(tmpdir(), "kage-file-"));
  try {
    const dir = join(root, "agent");
    await mkdir(dir, { recursive: true });
    const config = instanceConfigPath(dir);
    await writeFile(config, '{"model": ,}\n');
    await writeFile(join(dir, "persona.ts"), "x");
    await mkdir(join(root, "elsewhere"));
    await writeFile(join(root, "elsewhere", "fastagent.json"), "outside");
    await symlink(join(root, "elsewhere"), join(dir, "linked"));

    await assert.rejects(freshConfig(dir, join(dir, "persona.ts")), /is not this agent's fastagent.json/);
    await assert.rejects(freshConfig(dir, join(root, "elsewhere", "fastagent.json")), /is not this agent's/);
    await assert.rejects(freshConfig(dir, join(dir, "linked", "fastagent.json")), /is not this agent's/, "a link out of the folder");
    assert.equal(await readFile(join(root, "elsewhere", "fastagent.json"), "utf8"), "outside");

    const at = new Date(2026, 9, 3, 14, 40, 0);
    await freshConfig(dir, config, at);
    const kept = join(dir, "fastagent.json.broken-20261003-144000");
    assert.equal(await readFile(kept, "utf8"), '{"model": ,}\n', "the person's file is kept as it was");
    assert.equal(JSON.parse(await readFile(config, "utf8")).name, "agent");
    // A second reset in the same second (a double click) must not put the fresh file over the person's copy.
    await assert.rejects(freshConfig(dir, config, at), /EEXIST/);
    assert.equal(await readFile(kept, "utf8"), '{"model": ,}\n');

    await mkdir(join(dir, "skills"));
    await mkdir(join(dir, "prompts"));
    await writeFile(join(dir, "AGENTS.md"), "# agent\n");
    await (await openInstance(dir)).close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a load that failed in the instance's config is told apart by FastAgent's own words", async () => {
  const root = await mkdtemp(join(tmpdir(), "kage-config-"));
  const failure = async (name: string, config: string) => {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(instanceConfigPath(dir), config);
    const message = await openInstance(dir).then(
      () => assert.fail(`${name} loaded`),
      (error: Error) => error.message,
    );
    return { dir, message };
  };
  try {
    const cases: Record<string, string> = {
      syntax: "{not json",
      key: JSON.stringify({ modle: "x" }),
      path: JSON.stringify({ skills: ["./nowhere"] }),
    };
    for (const [name, config] of Object.entries(cases)) {
      const { dir, message } = await failure(name, config);
      assert.equal(failingConfig(dir, message), instanceConfigPath(dir), `${name}: ${message}`);
    }
    const { dir, message } = await failure("gone", JSON.stringify({ content: { work: { path: join(root, "missing") } } }));
    assert.equal(failingConfig(dir, message), undefined, `a folder that is gone is not the config: ${message}`);
    assert.equal(failingConfig("/x", "missing model: set --model"), undefined);
    assert.equal(failingConfig("/x", "/x/fastagent.json.broken-1: nope"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a created agent opens with kage's program: its folders, instructions and skills, and its state beside it", async () => {
  const root = await mkdtemp(join(tmpdir(), "kage-open-"));
  try {
    const registry = new AgentRegistry(join(root, "agents.json"));
    const handbook = join(root, "handbook");
    await mkdir(handbook);
    const { dir } = await createNewAgent({ name: "Opener", folders: [handbook], root: join(root, "Agents"), registry });
    await mkdir(join(dir, "skills", "demo"));
    await writeFile(join(dir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Says demo.\n---\n\nSay demo.\n");

    const agent = await openInstance(dir);
    try {
      const info = await agent.info();
      assert.equal(info.name, "Opener");
      assert.deepEqual(info.commands.map(({ name }) => name).sort(), ["skill:demo", "skill:writing-great-skills"]);
      assert.ok((await readdir(dir)).includes(".state"), "sessions are kept in the agent's own folder");
    } finally {
      await agent.close();
    }

    await writeFile(join(handbook, "x"), "");
    await rm(handbook, { recursive: true });
    await assert.rejects(listFolders(dir), /content "handbook": .* does not exist/);
    await assert.rejects(openInstance(dir), /content "handbook": .* does not exist/);
    assert.deepEqual(await removeFolderFromAgent(dir, "handbook"), []);
    await (await openInstance(dir)).close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secrets are the names the program declares, whether kage holds each, and never a value", async () => {
  const root = await mkdtemp(join(tmpdir(), "kage-inspect-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "# agent\n");
    const declared = [
      { name: "GITHUB_TOKEN", optional: false, description: "GitHub API access", declaredIn: ["src/tools/gh.ts"] },
      { name: "OPTIONAL_KEY", optional: true, declaredIn: ["src/tools/opt.ts"] },
    ];
    const inspected = await inspectAgentDir(root, declared, ["GITHUB_TOKEN"], "Reviews pull requests");
    assert.equal(inspected.description, "Reviews pull requests");
    assert.deepEqual(inspected.files, ["AGENTS.md"]);
    assert.deepEqual(inspected.secrets, [
      { name: "GITHUB_TOKEN", optional: false, description: "GitHub API access", declaredIn: ["src/tools/gh.ts"], configured: true },
      { name: "OPTIONAL_KEY", optional: true, declaredIn: ["src/tools/opt.ts"], configured: false },
    ]);

    assert.deepEqual(checkSecret(" GITHUB_TOKEN ", " a\"b\\c ", declared), { name: "GITHUB_TOKEN", value: 'a"b\\c' });
    assert.throws(() => checkSecret("OTHER", "x", declared), /OTHER is not a variable this agent's program reads/);
    assert.throws(() => checkSecret("GITHUB_TOKEN", "  ", declared), /cannot be empty/);
    assert.throws(() => checkSecret("GITHUB_TOKEN", "a\nb", declared), /newlines/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only a folder that is not there is missing; one that cannot be looked at says why", async () => {
  const root = await mkdtemp(join(tmpdir(), "kage-folder-"));
  try {
    await assert.rejects(requireFolder(join(root, "gone")), (error) => error instanceof MissingDirError && /ENOENT/.test(error.message));
    await writeFile(join(root, "file"), "");
    await assert.rejects(requireFolder(join(root, "file", "inside")), MissingDirError);
    await mkdir(join(root, "locked", "agent"), { recursive: true });
    await chmod(join(root, "locked"), 0o000);
    await assert.rejects(
      requireFolder(join(root, "locked", "agent")),
      (error) => !(error instanceof MissingDirError) && /EACCES/.test(String(error)),
      "a permission problem is not a folder to go and locate",
    );
  } finally {
    await chmod(join(root, "locked"), 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("agent paths resolve relative, home, and file-URL targets with line suffixes, and reject missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "kage-path-"));
  try {
    const agent = join(root, "agent");
    const home = join(root, "home");
    await mkdir(join(agent, "src"), { recursive: true });
    await mkdir(home, { recursive: true });
    const file = join(agent, "src", "index.ts");
    const note = join(home, "notes.md");
    await writeFile(file, "export {};\n");
    await writeFile(note, "# Notes\n");
    const canonicalFile = await realpath(file);
    const canonicalNote = await realpath(note);

    assert.equal(await resolveAgentPath(agent, "src/index.ts", home), canonicalFile);
    assert.equal(await resolveAgentPath(agent, "src/index.ts:42:5", home), canonicalFile);
    assert.equal(await resolveAgentPath(agent, "./src/index.ts#L10-L20", home), canonicalFile);
    assert.equal(await resolveAgentPath(agent, "./src/index.ts#the-workbench", home), canonicalFile);
    assert.equal(await resolveAgentPath(agent, "~/notes.md:3", home), canonicalNote);
    assert.equal(await resolveAgentPath(agent, `${pathToFileURL(file).href}#L8`, home), canonicalFile);
    await assert.rejects(resolveAgentPath(agent, "src/missing.ts:10", home), /ENOENT/);
    await assert.rejects(resolveAgentPath(agent, "   ", home), /Path cannot be empty/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
