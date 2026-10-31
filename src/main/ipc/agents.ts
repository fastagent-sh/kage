// The window's operations on agents and their models. Validation stays on this boundary; what an agent is and
// what it can run belongs to `main/agents.ts` and `main/models.ts`.
import { dialog, ipcMain, shell } from "electron";
import {
  addAgent,
  agentRow,
  createAgentIn,
  listAgents,
  openAgent,
  openAgentResult,
  registryFile,
  relocateAgent,
  resetAgentConfig,
  removeAgent,
  renameAgent,
  setAgentModel,
} from "../agents.ts";
import { modelsOf, offered } from "../models.ts";
import { refusal, refuse } from "../send.ts";
import type { Result } from "../../shared/result.ts";
import { MODEL_UNAVAILABLE_CODE } from "../../shared/refusals.ts";
import { endAgent, requireSession } from "./sessions.ts";

// Cutting an agent's subscriptions is invisible to the window unless each one says why it ended.
function ended(id: string, reason: string, result: Result): Result {
  if (result.ok) endAgent(id, reason);
  return result;
}

export function registerAgents(): void {
  ipcMain.handle("agents:list", () => listAgents());
  ipcMain.handle("agents:add", async () => {
    // createDirectory: the project you want an agent in may not exist yet, and macOS hides New Folder
    // unless it is asked for.
    const picked = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (!picked.canceled && picked.filePaths[0]) return addAgent(picked.filePaths[0]);
  });
  ipcMain.handle("agent:open", (_e, agentId: string) => openAgentResult(agentId));
  ipcMain.handle("agent:relocate", async (_e, id: string) => {
    const row = await agentRow(id);
    const picked = await dialog.showOpenDialog({ properties: ["openDirectory"], message: `Where is "${row.name}" now?` });
    if (picked.canceled || !picked.filePaths[0]) return undefined;
    return ended(id, "The agent was moved", await relocateAgent(row.id, picked.filePaths[0]));
  });
  ipcMain.handle("agent:resetConfig", async (_e, id: string) =>
    ended(id, "The agent's config was replaced", await resetAgentConfig(await agentRow(id))),
  );
  ipcMain.handle("agent:scaffold", async (_e, id: string) => (await createAgentIn((await agentRow(id)).dir)).dir);
  ipcMain.handle("agent:setModel", async (_e, id: string, model: string, session?: string) => {
    if (typeof model !== "string") throw new Error("Model must be a string");
    if (session !== undefined) requireSession(session);
    const row = await agentRow(id);
    if (!(await offered(await openAgent(row), model)))
      return refuse(MODEL_UNAVAILABLE_CODE, `${model} is not available to this agent — pick another.`);
    return refusal(() => setAgentModel(row, model, session));
  });
  ipcMain.handle("agent:remove", async (_e, id: string) => ended(id, "The agent was removed", await removeAgent(id)));
  ipcMain.handle("agent:rename", async (_e, id: string, name: string) => {
    if (typeof name !== "string" || !name.trim()) throw new Error("An agent name cannot be empty");
    await renameAgent((await agentRow(id)).id, name.trim());
  });
  ipcMain.handle("agent:commands", async (_e, id: string) =>
    (await (await openAgent(await agentRow(id))).info()).commands,
  );
  ipcMain.handle("agent:reveal", async (_e, id: string) => shell.showItemInFolder((await agentRow(id)).dir));
  ipcMain.handle("registry:reveal", () => shell.showItemInFolder(registryFile));
  ipcMain.handle("models:list", async (_e, id: string) => modelsOf(await openAgent(await agentRow(id))));
}
