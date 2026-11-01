// The renderer's whole privilege.
import { contextBridge, ipcRenderer } from "electron";
import type { AgentInfo, Entry, Message, Session } from "@fastagent-sh/fastagent";
import type { Result, Sent } from "../shared/result.ts";

export type { AgentRow } from "../main/agent-files.ts";
import type { AgentRow } from "../main/agent-files.ts";
export type { AgentCapability, AgentContent, AgentInspection, AgentSecretStatus, AgentSetup, OpenResult } from "../main/agents.ts";
import type { AgentContent, OpenResult } from "../main/agents.ts";
export type { ModelChoice, Models } from "../main/models.ts";
export type { SessionSummary } from "../main/session-list.ts";
import type { Models } from "../main/models.ts";
export type { ProviderUsage, UsageWindow } from "../main/usage.ts";
export type { AvatarStyle, Network } from "../main/settings.ts";
import type { AvatarStyle, Network, Settings } from "../main/settings.ts";
export type { Route } from "../main/proxy.ts";
export type { LoginMethod, LoginOutcome, LoginStep, ProviderRow } from "../main/providers.ts";
import type { LoginMethod, LoginOutcome, LoginStep, ProviderRow } from "../main/providers.ts";
import type { ConnectionCheck, Route } from "../main/proxy.ts";
import type { Frame } from "../main/follow.ts";
export type { Result, Sent };
export type AgentCommand = AgentInfo["commands"][number];
import type { ProviderUsage } from "../main/usage.ts";

export type SessionFrame = Frame;

const api = {
  listAgents: (): Promise<AgentRow[]> => ipcRenderer.invoke("agents:list"),
  pickFolder: (): Promise<{ name: string; path: string } | undefined> => ipcRenderer.invoke("agents:pickFolder"),
  createAgent: (name: string, folders: string[]): Promise<Result<{ agent: AgentRow }>> =>
    ipcRenderer.invoke("agents:create", name, folders),
  openAgent: (agentId: string): Promise<OpenResult> => ipcRenderer.invoke("agent:open", agentId),
  addAgentFolder: (agentId: string, folder: string): Promise<Result<{ content: AgentContent[] }>> =>
    ipcRenderer.invoke("agent:addFolder", agentId, folder),
  removeAgentFolder: (agentId: string, name: string): Promise<Result<{ content: AgentContent[] }>> =>
    ipcRenderer.invoke("agent:removeFolder", agentId, name),
  setModel: (agentId: string, model: string, session?: string): Promise<Result> =>
    ipcRenderer.invoke("agent:setModel", agentId, model, session),
  setThinking: (agentId: string, session: string, level: string): Promise<Result> =>
    ipcRenderer.invoke("session:setThinking", agentId, session, level),
  renameAgent: (agentId: string, name: string): Promise<void> => ipcRenderer.invoke("agent:rename", agentId, name),
  removeAgent: (agentId: string): Promise<Result> => ipcRenderer.invoke("agent:remove", agentId),
  resetAgentConfig: (agentId: string): Promise<Result> => ipcRenderer.invoke("agent:resetConfig", agentId),
  listCommands: (agentId: string): Promise<AgentCommand[]> => ipcRenderer.invoke("agent:commands", agentId),
  revealAgent: (agentId: string, path?: string): Promise<void> => ipcRenderer.invoke("agent:reveal", agentId, path),
  revealRegistry: (): Promise<void> => ipcRenderer.invoke("registry:reveal"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("app:openExternal", url),
  listModels: (agentId: string): Promise<Models> => ipcRenderer.invoke("models:list", agentId),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke("settings:get"),
  getRoute: (): Promise<Route> => ipcRenderer.invoke("network:route"),
  setAvatar: (style: AvatarStyle): Promise<void> => ipcRenderer.invoke("settings:setAvatar", style),
  setNetwork: (network: Network): Promise<Route> => ipcRenderer.invoke("settings:setNetwork", network),
  revealSettings: (): Promise<void> => ipcRenderer.invoke("settings:reveal"),
  testNetwork: (): Promise<ConnectionCheck> => ipcRenderer.invoke("network:test"),
  listProviders: (): Promise<ProviderRow[]> => ipcRenderer.invoke("providers:list"),
  revealProviders: (): Promise<void> => ipcRenderer.invoke("providers:reveal"),
  disconnect: (provider: string): Promise<void> => ipcRenderer.invoke("providers:disconnect", provider),
  login: (provider: string, method: LoginMethod): Promise<LoginOutcome> =>
    ipcRenderer.invoke("providers:login", provider, method),
  answerLogin: (id: string, value: string): Promise<void> => ipcRenderer.invoke("providers:answer", id, value),
  cancelLogin: (): Promise<void> => ipcRenderer.invoke("providers:cancel"),
  openLoginUrl: (url: string): Promise<void> => ipcRenderer.invoke("providers:open", url),
  onLoginStep: (listener: (step: LoginStep) => void): (() => void) => {
    const handler = (_e: unknown, step: LoginStep): void => listener(step);
    ipcRenderer.on("providers:step", handler);
    return () => void ipcRenderer.off("providers:step", handler);
  },
  providerUsage: (provider: string): Promise<ProviderUsage> => ipcRenderer.invoke("usage:get", provider),
  openUsagePage: (provider: string): Promise<void> => ipcRenderer.invoke("usage:open", provider),
  setUnseenCount: (count: number): Promise<void> => ipcRenderer.invoke("app:unseen", count),
  menu: <Id extends string>(items: { id: Id; label: string }[]): Promise<Id | undefined> =>
    ipcRenderer.invoke("menu:popup", items),
  createSession: (agentId: string): Promise<string> => ipcRenderer.invoke("session:create", agentId),
  openSession: (
    agentId: string,
    session: string,
    subscription: string,
  ): Promise<{ session: Session; entries: Entry[]; lastMessage?: Message }> => ipcRenderer.invoke("session:open", agentId, session, subscription),
  readState: (agentId: string, session: string): Promise<Session> =>
    ipcRenderer.invoke("session:state", agentId, session),
  closeSession: (subscription: string): Promise<void> => ipcRenderer.invoke("session:close", subscription),
  readSession: (agentId: string, session: string): Promise<Entry[]> =>
    ipcRenderer.invoke("session:entries", agentId, session),
  send: (agentId: string, session: string, text: string): Promise<Sent> =>
    ipcRenderer.invoke("session:send", agentId, session, text),
  abort: (agentId: string, session: string): Promise<Result> =>
    ipcRenderer.invoke("session:abort", agentId, session),
  onOpenSettings: (listener: () => void): (() => void) => {
    const handler = (): void => listener();
    ipcRenderer.on("app:settings", handler);
    // A request made before this listener existed (⌘, with no window open) is held by main.
    void ipcRenderer.invoke("app:settingsPending").then((pending: boolean) => pending && listener());
    return () => void ipcRenderer.off("app:settings", handler);
  },
  onSessionEvent: (listener: (frame: SessionFrame) => void): (() => void) => {
    const handler = (_e: unknown, frame: SessionFrame): void => listener(frame);
    ipcRenderer.on("session:event", handler);
    return () => void ipcRenderer.off("session:event", handler);
  },
};

export type DuangApi = typeof api;

contextBridge.exposeInMainWorld("duang", api);
