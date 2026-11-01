// The window's own concerns: its settings file, the network route, the Dock badge and the native row menus.
import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { join } from "node:path";
import { externalUrl } from "../../shared/links.ts";
import { applyNetwork, describeRoute, testConnection } from "../proxy.ts";
import { avatar, network, SettingsFile } from "../settings.ts";

const settings = new SettingsFile(join(app.getPath("userData"), "settings.json"));

// A new window's listener can register after `did-finish-load`, and a message to no listener is dropped,
// so the request waits until the renderer asks.
let settingsPending = false;

/** Opens Settings: in the window there is, or in a new one whose renderer asks for it once it can hear. */
export function requestSettings(openWindow: () => void): void {
  const existing = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (existing) {
    existing.show();
    existing.webContents.send("app:settings");
    return;
  }
  settingsPending = true;
  openWindow();
}

/** Startup reads it before the network is configured; an unreadable file is an error, not a first run. */
export const readAppSettings = () => settings.read();

export function registerApp(): void {
  // Read on every open, so a file fixed by hand shows without a restart. The route is its own call: a PAC
  // script can be slow, and the roster must not wait on it.
  ipcMain.handle("settings:get", () => settings.read());
  ipcMain.handle("network:route", () => describeRoute());
  ipcMain.handle("settings:setAvatar", (_e, value: unknown) => settings.change({ avatar: avatar(value) }));
  ipcMain.handle("settings:setNetwork", (_e, value: unknown) => {
    const next = network(value);
    return settings.change({ network: next }, async () => {
      await applyNetwork(next);
      return describeRoute();
    });
  });
  ipcMain.handle("settings:reveal", () => shell.showItemInFolder(settings.path));
  ipcMain.handle("app:settingsPending", () => {
    const pending = settingsPending;
    settingsPending = false;
    return pending;
  });
  ipcMain.handle("network:test", () => testConnection());
  ipcMain.handle("app:unseen", (_e, count: number) => {
    if (!Number.isInteger(count) || count < 0) throw new Error(`Unseen count must be a non-negative integer: ${count}`);
    app.setBadgeCount(count);
  });
  ipcMain.handle("app:openExternal", async (_e, url: string) => {
    const safe = typeof url === "string" ? externalUrl(url) : undefined;
    if (!safe) throw new Error(`Only http, https, and mailto links can be opened: ${String(url)}`);
    await shell.openExternal(safe);
  });

  // Native, so Rename looks like the system's. Chromium also raises `contextmenu` for Shift+F10 and the Menu key.
  ipcMain.handle("menu:popup", async (event, items: { id: string; label: string }[]) => {
    if (!Array.isArray(items) || items.some((item) => typeof item?.id !== "string" || typeof item.label !== "string"))
      throw new Error("Menu items must be { id, label } strings");
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    return new Promise<string | undefined>((resolve) => {
      const menu = Menu.buildFromTemplate(items.map(({ id, label }) => ({ label, click: () => resolve(id) })));
      menu.popup({ window: win, callback: () => resolve(undefined) });
    });
  });
}
