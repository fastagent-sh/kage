import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { addContent, createAgent, listContent, readContentSource, removeContent } from "@fastagent-sh/fastagent";
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

export async function addFolderToAgent(agentDir: string, folder: string): Promise<{ name: string; location: string }[]> {
  const real = await realpath(folder);
  const info = await stat(real);
  if (!info.isDirectory()) throw new Error(`Not a folder: ${folder}`);
  const { addition } = readContentSource(real, agentDir);
  const { content } = await addContent(agentDir, addition);
  return content.map(({ name, location }) => ({ name, location }));
}

export async function removeFolderFromAgent(agentDir: string, name: string): Promise<{ name: string; location: string }[]> {
  const { content } = await removeContent(agentDir, name);
  return content.map(({ name, location }) => ({ name, location }));
}

export interface AgentSecretStatus {
  name: string;
  optional: boolean;
  description?: string;
  declaredIn: string[];
  configured: boolean;
  fromFile?: boolean;
  fromEnv?: boolean;
}

export interface AgentInspection {
  description?: string;
  files: string[];
  packages: { name: string; version: string }[];
  secrets: AgentSecretStatus[];
}

const DEFINITION_FILES = ["SYSTEM.md", "APPEND_SYSTEM.md", "AGENTS.md", "fastagent.config.ts", "context.json"];
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function readTextIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseDotEnvLine(raw: string): { key: string; value: string } | undefined {
  const line = raw.trim();
  if (!line || line.startsWith("#")) return undefined;
  const eq = line.indexOf("=");
  if (eq < 1) return undefined;
  const key = line.slice(0, eq).trim();
  let value = line.slice(eq + 1).trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.at(-1) === quote) value = value.slice(1, -1);
  return { key, value };
}

function parseDotEnvMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const parsed = parseDotEnvLine(raw);
    if (!parsed) continue;
    if (parsed.value.trim()) map.set(parsed.key, parsed.value);
    else map.delete(parsed.key);
  }
  return map;
}

function formatDotEnvValue(value: string): string {
  const quote = value[0];
  if (((quote === '"' || quote === "'") && value.at(-1) === quote) || value !== value.trim()) {
    return `"${value}"`;
  }
  return value;
}

export async function inspectAgentDir(agentDir: string, description?: string): Promise<AgentInspection> {
  const [fileChecks, contextRaw, secretsRaw, envRaw] = await Promise.all([
    Promise.all(
      DEFINITION_FILES.map((file) =>
        stat(join(agentDir, file)).then(
          (info) => (info.isFile() ? file : undefined),
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          },
        ),
      ),
    ),
    readTextIfPresent(join(agentDir, "context.json")),
    readTextIfPresent(join(agentDir, ".fastagent", "secrets.json")),
    readTextIfPresent(join(agentDir, ".secrets", ".env")),
  ]);

  const files = fileChecks.filter((file): file is string => file !== undefined);
  const packages: { name: string; version: string }[] = [];
  const contextVariables = new Map<string, string | undefined>();
  if (contextRaw) {
    try {
      const parsed = JSON.parse(contextRaw) as {
        environment?: {
          packages?: Record<string, unknown>;
          aptPackages?: unknown[];
          variables?: Record<string, { description?: unknown }>;
        };
      };
      for (const [name, version] of Object.entries(parsed.environment?.packages ?? {})) {
        if (typeof version === "string") packages.push({ name, version });
      }
      for (const apt of parsed.environment?.aptPackages ?? []) {
        if (typeof apt === "string") packages.push({ name: `apt:${apt}`, version: "system" });
      }
      for (const [name, variable] of Object.entries(parsed.environment?.variables ?? {})) {
        const desc = variable && typeof variable === "object" && typeof variable.description === "string" ? variable.description : undefined;
        contextVariables.set(name, desc);
      }
    } catch {
      // Malformed context.json is reported by openAgentResult's listContent check.
    }
  }

  const configuredEnv = parseDotEnvMap(envRaw ?? "");
  const secrets: AgentSecretStatus[] = [];
  const seenSecrets = new Set<string>();
  const statusOf = (name: string) => {
    const fromEnv = name in process.env;
    const fromFile = configuredEnv.has(name);
    const configured = fromEnv ? Boolean(process.env[name]?.trim()) : fromFile;
    return { configured, fromEnv, fromFile };
  };

  if (secretsRaw !== undefined) {
    const secretsFile = join(agentDir, ".fastagent", "secrets.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(secretsRaw);
    } catch (error) {
      throw new Error(`${secretsFile}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!Array.isArray(parsed)) throw new Error(`${secretsFile}: expected an array of secrets`);
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const record = item as { name?: unknown; optional?: unknown; description?: unknown; declaredIn?: unknown };
      if (typeof record.name !== "string") continue;
      seenSecrets.add(record.name);
      const { configured, fromEnv, fromFile } = statusOf(record.name);
      secrets.push({
        name: record.name,
        optional: record.optional === true,
        ...(typeof record.description === "string" && { description: record.description }),
        declaredIn: Array.isArray(record.declaredIn)
          ? record.declaredIn.filter((source): source is string => typeof source === "string")
          : [],
        configured,
        ...(fromFile && { fromFile: true }),
        ...(fromEnv && { fromEnv: true }),
      });
    }
  }

  for (const [name, desc] of contextVariables) {
    if (seenSecrets.has(name)) continue;
    seenSecrets.add(name);
    const { configured, fromEnv, fromFile } = statusOf(name);
    secrets.push({
      name,
      optional: false,
      ...(desc && { description: desc }),
      declaredIn: ["context.json"],
      configured,
      ...(fromFile && { fromFile: true }),
      ...(fromEnv && { fromEnv: true }),
    });
  }

  for (const name of configuredEnv.keys()) {
    if (seenSecrets.has(name)) continue;
    const { configured, fromEnv, fromFile } = statusOf(name);
    secrets.push({
      name,
      optional: true,
      declaredIn: [".secrets/.env"],
      configured,
      ...(fromFile && { fromFile: true }),
      ...(fromEnv && { fromEnv: true }),
    });
  }

  return {
    ...(description && { description }),
    files,
    packages,
    secrets,
  };
}

export async function setAgentSecret(agentDir: string, rawName: string, rawValue: string): Promise<AgentInspection> {
  const name = rawName.trim();
  const value = rawValue.trim();
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new Error("Variable name must use letters, digits, and underscores (for example GITHUB_TOKEN)");
  }
  if (!value) throw new Error("Variable value cannot be empty");
  if (/[\r\n]/.test(value)) throw new Error("Variable value cannot contain newlines");
  const secretsDir = join(agentDir, ".secrets");
  await mkdir(secretsDir, { recursive: true });
  await writeFile(join(secretsDir, ".gitignore"), "*\n!.gitignore\n", { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
  const envFile = join(secretsDir, ".env");
  const existing = (await readTextIfPresent(envFile)) ?? "";
  const formatted = `${name}=${formatDotEnvValue(value)}`;
  const lines = existing === "" ? [] : existing.replace(/\n$/, "").split("\n");
  let replaced = false;
  const nextLines: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (parseDotEnvLine(line)?.key === name) {
      if (!replaced) {
        nextLines.unshift(formatted);
        replaced = true;
      }
    } else {
      nextLines.unshift(line);
    }
  }
  if (!replaced) nextLines.push(formatted);
  await writeFile(envFile, `${nextLines.join("\n")}\n`, { mode: 0o600 });
  return inspectAgentDir(agentDir);
}

export async function removeAgentSecret(agentDir: string, rawName: string): Promise<AgentInspection> {
  const name = rawName.trim();
  const envFile = join(agentDir, ".secrets", ".env");
  const existing = await readTextIfPresent(envFile);
  if (existing !== undefined) {
    const lines = existing
      .replace(/\n$/, "")
      .split("\n")
      .filter((line) => line !== "" && parseDotEnvLine(line)?.key !== name);
    await writeFile(envFile, lines.length > 0 ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
  }
  return inspectAgentDir(agentDir);
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
