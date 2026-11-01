import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent, listContent, readContentSource } from "@fastagent-sh/fastagent";
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
  const content = folders.map((folder) => readContentSource(folder, dir).addition);
  await createAgent(dir, content.length ? { content } : {});
  try {
    return await registry.add(dir, label);
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

const CONFIG_FILE = "fastagent.config.ts";
const FRESH_CONFIG = "export default {};\n";

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

// Every failure to load the config starts with its file name.
export function failingConfig(dir: string, message: string): string | undefined {
  return message.startsWith(`${CONFIG_FILE}: `) ? join(dir, CONFIG_FILE) : undefined;
}

export async function freshConfig(dir: string, config: string, now = new Date()): Promise<void> {
  const [root, real] = await Promise.all([realpath(dir), realpath(config)]);
  if (!real.startsWith(`${root}${sep}`) || basename(real) !== CONFIG_FILE) throw new Error(`${config} is not this agent's ${CONFIG_FILE}`);
  // Local time: people read this name.
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  // EXCL: a second reset in the same second fails here rather than replacing the person's file with the fresh one.
  await copyFile(real, `${real}.broken-${stamp}`, constants.COPYFILE_EXCL);
  await writeFile(real, FRESH_CONFIG);
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
    const entries = await listContent(agentDir).then(
      (res) => res.content,
      () => [],
    );
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
