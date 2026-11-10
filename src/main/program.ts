import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDefinition } from "@fastagent-sh/fastagent";

// The end-to-end scripts run a program with a model endpoint of their own.
const programDir = process.env.KAGE_PROGRAM_DIR ?? join(import.meta.dirname, "..", "..", "program", "dist");

let loaded: Promise<AgentDefinition> | undefined;

/** The program every agent runs: built into `program/dist` by `fastagent build` and shipped with the app. */
export function loadProgram(): Promise<AgentDefinition> {
  loaded ??= import(/* @vite-ignore */ pathToFileURL(join(programDir, "index.js")).href).then(
    (module: { default: AgentDefinition }) => module.default,
  );
  return loaded;
}
