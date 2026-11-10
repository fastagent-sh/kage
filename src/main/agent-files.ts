import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readContentSource } from "@fastagent-sh/fastagent";
import { stripPathSuffix } from "../shared/links.ts";
import { readJson, serially, writeJsonAtomic } from "./json-file.ts";

export interface AgentRow {
  id: string;
  name: string;
  dir: string;
  model?: string;
  // Lowest number free at assignment, kept for the agent's life; the renderer maps it onto its palette.
  colour: number;
}

const lowestFree = (rows: AgentRow[]): number => {
  const used = new Set(rows.map((row) => row.colour));
  let colour = 0;
  while (used.has(colour)) colour++;
  return colour;
};

function registryRows(rows: unknown): AgentRow[] {
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) =>
        !row ||
        typeof row.id !== "string" ||
        typeof row.name !== "string" ||
        typeof row.dir !== "string" ||
        (row.model !== undefined && typeof row.model !== "string") ||
        !(Number.isInteger(row.colour) && row.colour >= 0),
    ) ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  )
    throw new Error("invalid agent registry");
  return rows;
}

// Not a cache: a read error must never become an empty file on the next write.
export class AgentRegistry {
  private queue = serially();
  private file: string;
  constructor(file: string) {
    this.file = file;
  }

  async list(): Promise<AgentRow[]> {
    await this.queue.idle();
    return this.read();
  }

  private read(): Promise<AgentRow[]> {
    return readJson(this.file, [], registryRows);
  }

  private change<T>(edit: (rows: AgentRow[]) => T): Promise<T> {
    return this.queue.run(async () => {
      const rows = await this.read();
      const result = edit(rows);
      await writeJsonAtomic(this.file, rows);
      return result;
    });
  }

  async add(dir: string, name?: string): Promise<AgentRow> {
    const canonical = await realpath(dir);
    const label = name?.trim() || basename(canonical);
    return this.change((rows) => {
      const existing = rows.find((row) => row.dir === canonical);
      if (existing) return existing;
      const row = { id: randomUUID(), name: label, dir: canonical, colour: lowestFree(rows) };
      rows.push(row);
      return row;
    });
  }

  remove(id: string): Promise<void> {
    return this.change((rows) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) throw new Error(`unknown agent ${id}`);
      rows.splice(index, 1);
    });
  }

  rename(id: string, name: string): Promise<void> {
    return this.change((rows) => {
      const row = rows.find((row) => row.id === id);
      if (!row) throw new Error(`unknown agent ${id}`);
      row.name = name;
    });
  }

  setModel(id: string, model: string): Promise<void> {
    return this.change((rows) => {
      const row = rows.find((row) => row.id === id);
      if (!row) throw new Error(`unknown agent ${id}`);
      row.model = model;
    });
  }
}

export const agentsRoot = (homeDir = process.env.HOME || homedir()): string => join(homeDir, "Agents");

export function agentSlug(name: string): string {
  const slug = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return slug || "agent";
}

export async function nextAgentDir(name: string, root = agentsRoot()): Promise<string> {
  const base = agentSlug(name);
  const resolvedRoot = resolve(root);
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const candidate = resolve(resolvedRoot, slug);
    if (dirname(candidate) !== resolvedRoot) throw new Error(`Invalid agent directory: ${candidate}`);
    const exists = await lstat(candidate).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (!exists) return candidate;
  }
}

export function previewContentFolder(dir: string): { name: string; path: string } {
  const resolved = resolve(dir);
  return { name: readContentSource(resolved, resolved).addition.name, path: resolved };
}

const INSTANCE_CONFIG = "fastagent.json";
export const instanceConfigPath = (agentDir: string): string => join(agentDir, INSTANCE_CONFIG);

type FolderEntries = Record<string, { path: string }>;
type InstanceConfig = Record<string, unknown> & { content?: FolderEntries };

const instanceConfig = (name: string, content: FolderEntries = {}): InstanceConfig => ({
  name,
  instructions: ["./AGENTS.md"],
  skills: ["./skills"],
  prompts: ["./prompts"],
  ...(Object.keys(content).length > 0 && { content }),
});

const instanceConfigText = (config: InstanceConfig): string => `${JSON.stringify(config, null, 2)}\n`;

export interface AgentFolder {
  name: string;
  location: string;
}

async function readInstanceConfig(agentDir: string): Promise<InstanceConfig> {
  const file = instanceConfigPath(agentDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file}: expected an object`);
  return parsed as InstanceConfig;
}

function folderEntries(agentDir: string, config: InstanceConfig): FolderEntries {
  const file = instanceConfigPath(agentDir);
  const { content } = config;
  if (content === undefined) return {};
  if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error(`${file}: "content" must be an object`);
  for (const [name, entry] of Object.entries(content))
    if (typeof entry?.path !== "string") throw new Error(`${file}: content "${name}" is not a folder of this computer`);
  return content;
}

/** The folders the agent works on, as its configuration declares them; one that is gone is refused, naming it. */
export async function listFolders(agentDir: string): Promise<AgentFolder[]> {
  const entries = folderEntries(agentDir, await readInstanceConfig(agentDir));
  return Promise.all(
    Object.entries(entries).map(async ([name, { path }]) => {
      const location = resolve(agentDir, path);
      const info = await stat(location).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new Error(`content "${name}": ${location} does not exist`);
        throw error;
      });
      if (!info.isDirectory()) throw new Error(`content "${name}": ${location} is not a directory`);
      return { name, location: await realpath(location) };
    }),
  );
}

async function folderAddition(agentDir: string, folder: string): Promise<{ name: string; path: string }> {
  const real = await realpath(folder);
  if (!(await stat(real)).isDirectory()) throw new Error(`Not a folder: ${folder}`);
  const { name, entry } = readContentSource(real, agentDir).addition;
  const path = "path" in entry ? entry.path : real;
  const fromContent = relative(path, await realpath(agentDir));
  const outside = fromContent === ".." || fromContent.startsWith(`..${sep}`);
  if (!outside) throw new Error(`content "${name}": ${path} contains the agent directory`);
  return { name, path };
}

function withFolder(entries: FolderEntries, { name, path }: { name: string; path: string }): FolderEntries {
  const taken = Object.keys(entries).find((key) => key.toLowerCase() === name.toLowerCase());
  if (taken) throw new Error(`this agent already has content named "${taken}"`);
  return { ...entries, [name]: { path } };
}

const git = promisify(execFile);

// A missing git or commit identity leaves the agent without history, not without the agent.
async function initRepository(dir: string): Promise<void> {
  try {
    await git("git", ["init", "-q"], { cwd: dir });
    await git("git", ["add", "-A"], { cwd: dir });
    await git("git", ["commit", "-q", "-m", "Create the agent"], { cwd: dir });
  } catch (error) {
    console.error(`[kage] no git repository for ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function createNewAgent({
  name,
  folders = [],
  root = agentsRoot(),
  registry,
}: {
  name: string;
  folders?: string[];
  root?: string;
  registry: AgentRegistry;
}): Promise<AgentRow> {
  const label = name.trim();
  if (!label) throw new Error("Agent name is required");
  await registry.list();
  const dir = await nextAgentDir(label, root);
  await mkdir(dir, { recursive: true });
  try {
    let content: FolderEntries = {};
    for (const folder of folders) content = withFolder(content, await folderAddition(dir, folder));
    await Promise.all([
      writeFile(instanceConfigPath(dir), instanceConfigText(instanceConfig(basename(dir), content)), { flag: "wx" }),
      writeFile(join(dir, "AGENTS.md"), `# ${label}\n`, { flag: "wx" }),
      writeFile(join(dir, ".gitignore"), ".state\n", { flag: "wx" }),
      mkdir(join(dir, "skills")).then(() => writeFile(join(dir, "skills", ".gitkeep"), "")),
      mkdir(join(dir, "prompts")).then(() => writeFile(join(dir, "prompts", ".gitkeep"), "")),
    ]);
    await initRepository(dir);
    return await registry.add(dir, label);
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function editFolders(agentDir: string, edit: (entries: FolderEntries) => FolderEntries): Promise<AgentFolder[]> {
  const config = await readInstanceConfig(agentDir);
  const content = edit(folderEntries(agentDir, config));
  const { content: _replaced, ...rest } = config;
  await writeJsonAtomic(instanceConfigPath(agentDir), { ...rest, ...(Object.keys(content).length > 0 && { content }) });
  return listFolders(agentDir);
}

export async function addFolderToAgent(agentDir: string, folder: string): Promise<AgentFolder[]> {
  const addition = await folderAddition(agentDir, folder);
  return editFolders(agentDir, (entries) => withFolder(entries, addition));
}

export async function removeFolderFromAgent(agentDir: string, name: string): Promise<AgentFolder[]> {
  return editFolders(agentDir, (entries) => {
    const found = Object.keys(entries).find((key) => key.toLowerCase() === name.toLowerCase());
    if (!found) throw new Error(`this agent has no content named "${name}"`);
    const { [found]: _removed, ...rest } = entries;
    return rest;
  });
}

export interface AgentSecretStatus {
  name: string;
  optional: boolean;
  description?: string;
  declaredIn: string[];
  configured: boolean;
}

export interface AgentInspection {
  description?: string;
  files: string[];
  secrets: AgentSecretStatus[];
}

const INSTANCE_FILES = ["AGENTS.md", INSTANCE_CONFIG];

export interface DeclaredSecret {
  name: string;
  optional: boolean;
  description?: string;
  declaredIn: readonly string[];
}

/** The secrets the program declares and whether kage holds each; no value is ever read out. */
export async function inspectAgentDir(
  agentDir: string,
  declared: readonly DeclaredSecret[],
  stored: readonly string[],
  description?: string,
): Promise<AgentInspection> {
  const files = (
    await Promise.all(
      INSTANCE_FILES.map((file) =>
        stat(join(agentDir, file)).then(
          (info) => (info.isFile() ? file : undefined),
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          },
        ),
      ),
    )
  ).filter((file): file is string => file !== undefined);
  const secrets: AgentSecretStatus[] = declared.map(({ name, optional, description, declaredIn }) => ({
    name,
    optional,
    ...(description && { description }),
    declaredIn: [...declaredIn],
    configured: stored.includes(name),
  }));
  return { ...(description && { description }), files, secrets };
}

export function checkSecret(rawName: string, rawValue: string, declared: readonly DeclaredSecret[]): { name: string; value: string } {
  const name = rawName.trim();
  const value = rawValue.trim();
  if (!declared.some((secret) => secret.name === name)) throw new Error(`${name} is not a variable this agent's program reads`);
  if (!value) throw new Error("Variable value cannot be empty");
  if (/[\r\n]/.test(value)) throw new Error("Variable value cannot contain newlines");
  return { name, value };
}

export class MissingDirError extends Error {}

// Only ENOENT is missing; other failures (permissions, macOS privacy) surface as themselves.
export async function requireFolder(dir: string): Promise<void> {
  try {
    await stat(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new MissingDirError((error as Error).message);
    throw error;
  }
}

// Every failure to load the config starts with its path.
export function failingConfig(dir: string, message: string): string | undefined {
  const config = instanceConfigPath(dir);
  return message.startsWith(`${config}:`) || message.startsWith(`${config} `) ? config : undefined;
}

export async function freshConfig(dir: string, config: string, now = new Date()): Promise<void> {
  if ((await realpath(config)) !== join(await realpath(dir), INSTANCE_CONFIG)) throw new Error(`${config} is not this agent's ${INSTANCE_CONFIG}`);
  // Local time: people read this name.
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  // EXCL: a second reset in the same second fails here rather than replacing the person's file with the fresh one.
  await copyFile(config, `${config}.broken-${stamp}`, constants.COPYFILE_EXCL);
  await writeFile(config, instanceConfigText(instanceConfig(basename(dir))));
}

export async function resolveAgentPath(agentDir: string, rawPath: string, homeDir = homedir()): Promise<string> {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error("Path cannot be empty");
  const fromUrl = /^file:\/\//i.test(trimmed) ? fileURLToPath(new URL(trimmed)) : trimmed;
  const clean = stripPathSuffix(fromUrl);
  if (!clean) throw new Error(`Invalid path: ${rawPath}`);
  if (clean === "~" || clean.startsWith("~/")) {
    return realpath(clean === "~" ? homeDir : join(homeDir, clean.slice(2)));
  }
  if (isAbsolute(clean)) {
    return realpath(clean);
  }
  try {
    return await realpath(resolve(agentDir, clean));
  } catch (firstError) {
    const entries = await listFolders(agentDir).catch(() => []);
    for (const entry of entries) {
      if (clean === entry.name) return realpath(entry.location);
      if (clean.startsWith(`${entry.name}/`)) {
        const inside = await realpath(resolve(entry.location, clean.slice(entry.name.length + 1))).catch(() => undefined);
        if (inside) return inside;
      }
    }
    for (const entry of entries) {
      const direct = await realpath(resolve(entry.location, clean)).catch(() => undefined);
      if (direct) return direct;
    }
    throw firstError;
  }
}
