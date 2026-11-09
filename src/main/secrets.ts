import { readJson, serially, writeJsonAtomic } from "./json-file.ts";

type AgentSecrets = Record<string, Record<string, string>>;

function agentSecrets(value: unknown): AgentSecrets {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some(
      (values) => !values || typeof values !== "object" || Object.values(values).some((secret) => typeof secret !== "string"),
    )
  )
    throw new Error("invalid secrets file");
  return value as AgentSecrets;
}

// Values an agent's tools and MCP servers read by name. Not a cache: a read error must never become an empty file on the next write.
export class SecretStore {
  private queue = serially();
  private file: string;
  constructor(file: string) {
    this.file = file;
  }

  async get(agentId: string): Promise<Record<string, string>> {
    await this.queue.idle();
    return (await this.read())[agentId] ?? {};
  }

  private read(): Promise<AgentSecrets> {
    return readJson(this.file, {}, agentSecrets);
  }

  private change(edit: (all: AgentSecrets) => void): Promise<void> {
    return this.queue.run(async () => {
      const all = await this.read();
      edit(all);
      await writeJsonAtomic(this.file, all);
    });
  }

  set(agentId: string, name: string, value: string): Promise<void> {
    return this.change((all) => {
      all[agentId] = { ...all[agentId], [name]: value };
    });
  }

  remove(agentId: string, name: string): Promise<void> {
    return this.change((all) => {
      const { [name]: _removed, ...rest } = all[agentId] ?? {};
      if (Object.keys(rest).length > 0) all[agentId] = rest;
      else delete all[agentId];
    });
  }

  removeAgent(agentId: string): Promise<void> {
    return this.change((all) => {
      delete all[agentId];
    });
  }
}
