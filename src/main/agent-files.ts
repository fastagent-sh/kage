import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { createAgent } from "@fastagent-sh/fastagent";
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

  async add(dir: string): Promise<AgentRow> {
    const canonical = await realpath(dir);
    return this.change((rows) => {
      const existing = rows.find((row) => row.dir === canonical);
      if (existing) return existing;
      const row = { id: randomUUID(), name: basename(canonical), dir: canonical, colour: lowestFree(rows) };
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

  async relocate(id: string, dir: string): Promise<void> {
    const canonical = await realpath(dir);
    return this.change((rows) => {
      const row = rows.find((row) => row.id === id);
      if (!row) throw new Error(`unknown agent ${id}`);
      const other = rows.find((other) => other.dir === canonical && other.id !== id);
      if (other) throw new Error(`${canonical} is already the agent "${other.name}"`);
      row.dir = canonical;
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

// FastAgent opens a folder with no agent in it as an empty one, so the agent is recognised by its config.
export async function hasAgent(dir: string): Promise<boolean> {
  return stat(join(dir, CONFIG_FILE)).then(
    (file) => file.isFile(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    },
  );
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

// The folder is the agent. FastAgent refuses one that holds anything, so the person's own files are never touched.
export const createAgentIn = (dir: string) => createAgent(dir);
