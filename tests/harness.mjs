// Keeps the developer's credentials and proxy out of every end-to-end run.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import electron from "electron";

const PRIVATE = /API_KEY|TOKEN|SECRET|^FASTAGENT_|^AWS_|^GOOGLE_|^AZURE_|^PI_|PROXY$/i;

const ROOT = join(import.meta.dirname, "..");
// What `npm run build` reads. A dependency or lockfile change needs `npm ci` as well, which no freshness check can see.
const SOURCES = ["src", "electron.vite.config.ts", "tsconfig.json"];
const BUILT = ["out/main/index.js", "out/preload/index.mjs", "out/renderer/index.html"];

function newestMtime(target, root) {
  const full = join(root, target);
  const stat = statSync(full, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (stat.isFile()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(full, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    newest = Math.max(newest, statSync(join(entry.parentPath ?? entry.path, entry.name)).mtimeMs);
  }
  return newest;
}

/**
 * Refuses when the build the scripts load is older than the sources. A stale bundle answers for code nobody
 * ran: a smoke run against a stale `out/` was reported as a passing verification once, and cost a second look
 * to notice. `outputs` and `how` are for `packaged.mjs`, which loads the packaged app instead.
 */
export function requireFreshBuild(outputs = BUILT, how = "npm run build") {
  const newest = Math.max(...SOURCES.map((source) => newestMtime(source, ROOT)));
  const oldest = Math.min(
    ...outputs.map((output) => statSync(resolve(ROOT, output), { throwIfNoEntry: false })?.mtimeMs || 0),
  );
  if (oldest > newest) return;
  throw new Error(
    `${outputs[0]} is missing or older than ${SOURCES.join(", ")}: run \`${how}\` first.\n` +
      "These scripts load the built app, so a stale build answers about code that is not in it.",
  );
}

// FastAgent asks pi.dev for newer model lists whenever an agent opens; a test must not depend on the network.
export function withoutCredentials(env) {
  for (const name of Object.keys(env)) if (PRIVATE.test(name)) delete env[name];
  env.FASTAGENT_OFFLINE = "1";
  return env;
}

// The root goes only after Electron exited, so Chromium has stopped writing its caches into it.
export async function isolated(script, { name, timeout, home = true, program, prepare, after }) {
  if (process.versions.electron) {
    const root = process.env.KAGE_TEST_ROOT;
    if (!root) throw new Error(`Run with node tests/${name}.mjs so the fixture is isolated`);
    return root;
  }
  const root = mkdtempSync(join(tmpdir(), `kage-${name}-`));
  try {
    // Before the fixture, so a stale build fails in a second rather than after a launch and a fake run.
    requireFreshBuild();
    if (program) process.env.KAGE_PROGRAM_DIR = buildMockProgram(root, program);
    await prepare?.(root);
    const child = spawnSync(electron, [fileURLToPath(script)], {
      stdio: "inherit",
      env: { ...process.env, KAGE_TEST_ROOT: root, ...(home ? { HOME: root } : {}) },
      timeout,
    });
    process.exitCode = child.status ?? 1;
    // What can only be read once Electron has exited and let go of its files.
    if (child.status === 0) await after?.(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return undefined;
}

export const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

/**
 * A program like kage's own, with one more provider: `mock/mock`, an OpenAI-compatible endpoint at
 * `KAGE_MOCK_MODEL_URL`, read when the program loads. Built into `<root>/mock-program/dist`, which the scripts
 * hand to kage as `KAGE_PROGRAM_DIR`. Its modules are the repository's; `useModules` points them elsewhere.
 */
export function buildMockProgram(root, { provider = "mock", modelId = "mock", extraModels = 0, model = {}, needsCredential = false } = {}) {
  const dir = join(root, "mock-program");
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mock-agent", private: true, type: "module", version: "0.0.0" }));
  writeFileSync(join(dir, "SYSTEM.md"), "You are a test agent.\n");
  cpSync(join(ROOT, "program", "skills"), join(dir, "skills"), { recursive: true });
  writeFileSync(
    join(dir, "fastagent.config.ts"),
    `import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const baseUrl = process.env.KAGE_MOCK_MODEL_URL;
if (!baseUrl) throw new Error("KAGE_MOCK_MODEL_URL names the endpoint the mock program talks to");
const mock = createProvider({
  id: ${JSON.stringify(provider)},
  name: ${JSON.stringify(provider)},
  baseUrl,
  auth: { apiKey: { name: "Mock", resolve: async ({ credential }) => (${needsCredential} && !credential?.key ? undefined : { auth: { apiKey: credential?.key ?? "mock" } }) } },
  models: ${JSON.stringify(
    Array.from({ length: extraModels + 1 }, (_, n) => {
      const id = n === 0 ? modelId : `${modelId}-extra-${n}`;
      return {
        id, name: id, api: "openai-completions", provider, baseUrl: "BASE_URL",
        reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65536, maxTokens: 8192, ...model,
      };
    }),
  ).replaceAll('"BASE_URL"', "baseUrl")},
  api: openAICompletionsApi(),
});

export default { name: "mock-agent", providers: [mock] };
`,
  );
  const build = spawnSync(join(ROOT, "node_modules", ".bin", "fastagent"), ["build", dir], {
    encoding: "utf8",
    env: { ...process.env, KAGE_MOCK_MODEL_URL: "http://127.0.0.1:9/v1" },
  });
  if (build.status !== 0) throw new Error(`the mock program did not build:\n${build.stderr}${build.stdout}`);
  return join(dir, "dist");
}

/** The mock program's modules from `modules` instead: an extracted app's, so it runs on the copy the app holds. */
export function useModules(root, modules) {
  const link = join(root, "mock-program", "node_modules");
  rmSync(link);
  symlinkSync(modules, link);
}

/** An agent's folder as kage creates it, with the model it starts on and the skills it already has. */
export function writeInstance(dir, { model, skills = {}, content } = {}) {
  mkdirSync(join(dir, "prompts"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# Agent\n");
  writeFileSync(
    join(dir, "fastagent.json"),
    JSON.stringify({ name: basename(dir), ...(model && { model }), ...(content && { content }), instructions: ["./AGENTS.md"], skills: ["./skills"], prompts: ["./prompts"] }),
  );
  mkdirSync(join(dir, "skills"), { recursive: true });
  for (const [name, description] of Object.entries(skills)) {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nDo ${name}.\n`);
  }
}

/** Opens an instance in a script's own process, for the conversation a test starts from. Close it before kage opens it. */
export async function openInstance(dir) {
  const { openAgent, baseEnv } = await import("@fastagent-sh/fastagent");
  const program = (await import(pathToFileURL(join(process.env.KAGE_PROGRAM_DIR, "index.js")).href)).default;
  return openAgent(program, { root: dir, config: join(dir, "fastagent.json"), secrets: {}, env: baseEnv(process.env), offline: true });
}
