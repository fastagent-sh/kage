// FastAgent expands the command (SPEC §5.1), not duang, so a remote agent works the same way.
import type { AgentCommand } from "../preload/index.ts";

// Past the first space the line is arguments, the agent's to read.
export function completionQuery(value: string): string | undefined {
  const match = /^\/(\S*)$/.exec(value);
  return match?.[1];
}

// A skill is typed as `skill:name`, and found by `name` too.
const withoutSkillPrefix = (name: string) => name.replace(/^skill:/, "");

export function matches(commands: AgentCommand[], query: string, limit = 8): AgentCommand[] {
  const needle = query.toLowerCase();
  return commands
    .filter((c) => c.name.toLowerCase().startsWith(needle) || withoutSkillPrefix(c.name).toLowerCase().startsWith(needle))
    .slice(0, limit);
}

export function complete(command: AgentCommand): string {
  return `/${command.name} `;
}
