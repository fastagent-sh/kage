// Signing in to a model provider, and the plan usage that login makes readable. One sign-in runs at a time, and
// no message to the renderer ever carries credential contents.
import { ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { authPath, credentials } from "../credential-file.ts";
import { disconnect, listProviders, startLogin, type LoginMethod, type LoginOutcome } from "../providers.ts";
import { forgetUsage, providerUsage, usagePage } from "../usage.ts";

let signIn: { senderId: number; flow: ReturnType<typeof startLogin> } | undefined;

/** A window that is gone has nobody to answer its sign-in, so it ends, which also closes the provider's callback server. */
export function releaseSignIn(senderId: number): void {
  if (signIn?.senderId === senderId) signIn.flow.cancel();
}

export function registerProviders(): void {
  ipcMain.handle("providers:list", () => listProviders(credentials));
  ipcMain.handle("providers:reveal", () =>
    existsSync(authPath) ? shell.showItemInFolder(authPath) : shell.openPath(dirname(authPath)),
  );
  ipcMain.handle("providers:disconnect", async (_e, provider: string) => {
    if (typeof provider !== "string" || !provider) throw new Error("Provider must be a non-empty string");
    await disconnect(credentials, provider);
    forgetUsage(provider, authPath);
  });
  ipcMain.handle("providers:login", async (e, provider: string, method: LoginMethod): Promise<LoginOutcome> => {
    if (typeof provider !== "string" || (method !== "oauth" && method !== "api_key"))
      throw new Error("A sign-in names a provider and oauth or api_key");
    if (signIn) return { ok: false, error: "Another sign-in is in progress." };
    const flow = startLogin({
      provider,
      method,
      credentials,
      send: (step) => {
        if (!e.sender.isDestroyed()) e.sender.send("providers:step", step);
      },
      open: (url) => shell.openExternal(url),
    });
    signIn = { senderId: e.sender.id, flow };
    try {
      const outcome = await flow.result;
      if (outcome.ok) forgetUsage(provider, authPath);
      return outcome;
    } finally {
      signIn = undefined;
    }
  });
  ipcMain.handle("providers:answer", (e, id: string, value: string) => {
    if (typeof id !== "string" || typeof value !== "string") throw new Error("An answer is a prompt id and a string");
    if (signIn?.senderId === e.sender.id) signIn.flow.answer(id, value);
  });
  ipcMain.handle("providers:cancel", (e) => {
    if (signIn?.senderId === e.sender.id) signIn.flow.cancel();
  });
  ipcMain.handle("providers:open", async (e, url: string) => {
    if (signIn?.senderId !== e.sender.id) throw new Error("No sign-in is in progress");
    await signIn.flow.reopen(url);
  });
  ipcMain.handle("usage:get", (_e, provider: string) => {
    if (typeof provider !== "string" || !provider) throw new Error("Provider must be a non-empty string");
    return providerUsage(provider, authPath);
  });
  ipcMain.handle("usage:open", (_e, provider: string) => {
    if (typeof provider !== "string") throw new Error("Provider must be a string");
    return shell.openExternal(usagePage(provider));
  });
}
