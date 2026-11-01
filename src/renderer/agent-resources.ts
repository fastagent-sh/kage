import type { AgentCommand, DuangApi, Models } from "../preload/index.ts";
import { message } from "./message.ts";

export interface AgentResourcesView {
  models?: Models;
  modelsError?: string;
  commands: AgentCommand[];
  commandsError?: string;
}

export function createAgentResources(api: DuangApi, publish: (patch: Partial<AgentResourcesView>) => void) {
  let selected: { id: string } | undefined;
  let modelRead: object | undefined;
  let commandsFor: typeof selected;
  return {
    select(id?: string) {
      selected = id ? { id } : undefined;
      modelRead = commandsFor = undefined;
      publish({ models: undefined, modelsError: undefined, commands: [], commandsError: undefined });
    },
    closeModels() {
      modelRead = undefined;
    },
    resetCommands() {
      commandsFor = undefined;
      publish({ commands: [], commandsError: undefined });
    },
    async loadModels() {
      const origin = selected;
      const request = (modelRead = {});
      publish({ models: undefined, modelsError: undefined });
      if (!origin) return;
      try {
        const answer = await api.listModels(origin.id);
        if (selected !== origin || modelRead !== request) return;
        publish({ models: answer });
      } catch (error) {
        if (selected === origin && modelRead === request) publish({ modelsError: message(error) });
      }
    },
    async loadCommands() {
      const origin = selected;
      if (!origin || commandsFor === origin) return;
      commandsFor = origin;
      try {
        const commands = await api.listCommands(origin.id);
        if (selected === origin) publish({ commands, commandsError: undefined });
      } catch (error) {
        if (selected !== origin) return;
        commandsFor = undefined;
        publish({ commandsError: message(error) });
      }
    },
  };
}
