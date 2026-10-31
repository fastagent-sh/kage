// The window's whole privilege, by domain. main/index.ts registers it and uses what lifecycle needs to stay in
// step with it: releasing a window, and stopping runs before a quit.
import { registerAgents } from "./agents.ts";
import { registerApp } from "./app.ts";
import { registerProviders, releaseSignIn } from "./providers.ts";
import { closeWindow, quitSends, registerSessions } from "./sessions.ts";

export function registerIpc(): void {
  registerSessions();
  registerAgents();
  registerProviders();
  registerApp();
}

/** A window that is closing or reloading leaves nobody to answer its subscriptions or its sign-in. */
export function releaseWindow(senderId: number): void {
  closeWindow(senderId);
  releaseSignIn(senderId);
}

export { readAppSettings, requestSettings } from "./app.ts";
export { quitSends };
