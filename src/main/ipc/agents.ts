// The window's operations on agents and their models. Validation stays on this boundary; what an agent is and
// what it can run belongs to `main/agents.ts` and `main/models.ts`.
import { dialog, ipcMain, shell } from "electron";
import {
  addAgentFolder,
  agentRow,
  createAgentWithFolders,
  forgetAgentModel,
  listAgents,
  openAgent,
  openAgentResult,
  previewContentFolder,
  registryFile,
  removeAgentFolder,
  removeAgentSecret,
  resetAgentConfig,
  removeAgent,
  renameAgent,
  resolveAgentPath,
  setAgentModel,
  setAgentSecret,
} from "../agents.ts";
import { modelsOf, offered } from "../models.ts";
import { refusal, refuse } from "../send.ts";
import type { Result } from "../../shared/result.ts";
import { MODEL_UNAVAILABLE_CODE } from "../../shared/refusals.ts";
import { endAgent, releaseAgent, requireSession } from "./sessions.ts";

// Cutting an agent's subscriptions is invisible to the window unless each one says why it ended.
function ended(id: string, reason: string, result: Result): Result {
  if (result.ok) endAgent(id, reason);
  return result;
}

export function registerAgents(): void {
  ipcMain.handle("agents:list", () => listAgents());
  ipcMain.handle("agents:pickFolder", async () => {
    const picked = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (!picked.canceled && picked.filePaths[0]) return previewContentFolder(picked.filePaths[0]);
  });
  ipcMain.handle("agents:create", async (_e, name: string, folders: string[]) => {
    if (typeof name !== "string") throw new Error("Agent name must be a string");
    if (!Array.isArray(folders) || folders.some((folder) => typeof folder !== "string"))
      throw new Error("Folders must be an array of paths");
    return createAgentWithFolders(name, folders);
  });
  ipcMain.handle("agent:open", (_e, agentId: string) => openAgentResult(agentId));
  ipcMain.handle("agent:addFolder", async (_e, id: string, folder: string) => {
    if (typeof folder !== "string" || !folder.trim()) throw new Error("Folder path must be a string");
    return addAgentFolder(await agentRow(id), folder, () => releaseAgent(id));
  });
  ipcMain.handle("agent:removeFolder", async (_e, id: string, name: string) => {
    if (typeof name !== "string" || !name.trim()) throw new Error("Folder name must be a string");
    return removeAgentFolder(await agentRow(id), name, () => releaseAgent(id));
  });
  ipcMain.handle("agent:setSecret", async (_e, id: string, name: string, value: string) => {
    if (typeof name !== "string" || typeof value !== "string") throw new Error("Secret name and value must be strings");
    return setAgentSecret(await agentRow(id), name, value, () => releaseAgent(id));
  });
  ipcMain.handle("agent:removeSecret", async (_e, id: string, name: string) => {
    if (typeof name !== "string") throw new Error("Secret name must be a string");
    return removeAgentSecret(await agentRow(id), name, () => releaseAgent(id));
  });
  ipcMain.handle("agent:resetConfig", async (_e, id: string) =>
    ended(id, "The agent's config was replaced", await resetAgentConfig(await agentRow(id))),
  );
  ipcMain.handle("agent:forgetModel", async (_e, id: string) =>
    ended(id, "The agent's default model was forgotten", await forgetAgentModel(await agentRow(id))),
  );
  ipcMain.handle("agent:setModel", async (_e, id: string, model: string, session?: string) => {
    if (typeof model !== "string") throw new Error("Model must be a string");
    if (session !== undefined) requireSession(session);
    const row = await agentRow(id);
    if (!(await offered(await openAgent(row), model)))
      return refuse(MODEL_UNAVAILABLE_CODE, `${model} is not available to this agent — pick another.`);
    return refusal(() => setAgentModel(row, model, session));
  });
  ipcMain.handle("agent:remove", async (_e, id: string) =>
    ended(id, "The agent was removed", await removeAgent(id, (dir) => shell.trashItem(dir))),
  );
  ipcMain.handle("agent:rename", async (_e, id: string, name: string) => {
    if (typeof name !== "string" || !name.trim()) throw new Error("An agent name cannot be empty");
    await renameAgent((await agentRow(id)).id, name.trim());
  });
  ipcMain.handle("agent:commands", async (_e, id: string) =>
    (await (await openAgent(await agentRow(id))).info()).commands,
  );
  ipcMain.handle("agent:reveal", async (_e, id: string, path?: string) => {
    if (path !== undefined && typeof path !== "string") throw new Error("Path must be a string");
    const row = await agentRow(id);
    const target = path ? await resolveAgentPath(row.dir, path) : row.dir;
    shell.showItemInFolder(target);
  });
  ipcMain.handle("registry:reveal", () => shell.showItemInFolder(registryFile));
  ipcMain.handle("models:list", async (_e, id: string) => modelsOf(await openAgent(await agentRow(id))));
}
