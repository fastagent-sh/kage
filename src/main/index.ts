import { app, BrowserWindow, dialog, Menu, nativeTheme, shell } from "electron";
import { join } from "node:path";
import { externalUrl } from "../shared/links.ts";
import {
  readAppSettings,
  registerIpc,
  releaseWindow,
  quitSends,
  requestSettings,
} from "./ipc/index.ts";
import { closeAgents, runsBusy, stopAllRuns } from "./agents.ts";
import { applyNetwork } from "./proxy.ts";
import { DEFAULTS } from "./settings.ts";
import { rememberBounds, savedBounds } from "./window-state.ts";

// Replacing Electron's default menu replaces all of it; without the Edit roles ⌘C and ⌘V stop working.
function setApplicationMenu(): void {
  if (process.platform !== "darwin") return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { id: "settings", label: "Settings…", accelerator: "Command+,", click: () => requestSettings(createWindow) },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...savedBounds(),
    minWidth: 800,
    minHeight: 540,
    titleBarStyle: "hiddenInset",
    // Tighter to the top than centring: with the panel 8 below the edge, centring reads as a gap above.
    trafficLightPosition: { x: 18, y: 18 },
    // No vibrancy: every surface is opaque. Matching the renderer's canvas avoids a flash at launch.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1b1d" : "#fcfcfc",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  rememberBounds(win);
  // Model-generated links must never navigate a privileged renderer to another origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const safe = externalUrl(url);
    if (safe) void shell.openExternal(safe);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  const senderId = win.webContents.id;
  // Closing or reloading the window (⌘R, a renderer crash) leaves nobody to answer its subscriptions or its
  // sign-in; the webContents id survives a reload, which is why it is the id and not the window.
  const release = () => releaseWindow(senderId);
  win.webContents.on("destroyed", release);
  win.webContents.on("did-start-loading", release);
  reloadWhenGone(win);
  load(win);
  return win;
}

// `fresh` opens on a new conversation, for a window that crashed drawing the last one.
function load(win: BrowserWindow, fresh = false): void {
  if (process.env.ELECTRON_RENDERER_URL)
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${fresh ? "#fresh" : ""}`);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"), fresh ? { hash: "fresh" } : {});
}

const CRASH_SPAN_MS = 60_000;
const CRASH_LIMIT = 2;
/** For the app, not one window: a window closed and opened again from the Dock starts no new count. */
const crashes: number[] = [];

// A crashed renderer leaves a blank window while its runs go on here, so reload. One that keeps crashing
// likely redraws what crashed it: ask first, and open on a new conversation.
function reloadWhenGone(win: BrowserWindow): void {
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    console.error(`duang: the window's renderer ended (${details.reason}, exit code ${details.exitCode})`);
    const now = Date.now();
    crashes.push(now);
    while (crashes[0]! < now - CRASH_SPAN_MS) crashes.shift();
    if (crashes.length <= CRASH_LIMIT) return win.webContents.reload();
    void dialog
      .showMessageBox(win, {
        type: "error",
        message: "duang's window keeps crashing.",
        detail: `It ended ${crashes.length} times in the last minute (${details.reason}). The conversation it was showing may be what crashes it, so it opens on a new conversation; that one stays in the list. Runs in progress keep going.`,
        buttons: ["Open on a New Conversation", "Close Window"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (win.isDestroyed()) return;
        if (response === 0) load(win, true);
        else win.destroy();
      });
  });
}



// One duang per userData (the app and `npm run dev` share it): two would write one registry with no lock and
// refresh one OAuth login twice.
if (!app.requestSingleInstanceLock()) {
  console.error(`duang is already running with ${app.getPath("userData")}; showing that one instead.`);
  app.exit(0);
} else
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return void createWindow();
    if (window.isMinimized()) window.restore();
    window.focus();
  });

void app
  .whenReady()
  .then(async () => {
    let saved = DEFAULTS;
    try {
      saved = await readAppSettings();
    } catch (error) {
      // Guessing a manual proxy is worse than the system's; said here and on Settings until the file is fixed.
      dialog.showErrorBox(
        "duang could not read its settings",
        `${(error as Error).message}\n\nThe network follows the system proxy until the file is fixed or removed.`,
      );
    }
    await applyNetwork(saved.network);
    setApplicationMenu();
    registerIpc();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error) => {
    console.error(error);
    dialog.showErrorBox("duang could not start", String(error));
    app.quit();
  });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// A run keeps going only while duang does, so ask. Quit anyway records a stop for each, as Stop does, so none is
// answered at the next launch, and closing the agents gives their work a moment to end.
const CLOSE_WAIT_MS = 3000;
let phase: "running" | "asking" | "stopping" | "leaving" = "running";

// Whether quitting goes on. Releasing an instance's storage is what lets the next launch open it.
async function readyToQuit(): Promise<boolean> {
  let busy = false;
  try {
    busy = await runsBusy();
  } catch (error) {
    // Not being able to look must not keep the app from quitting.
    console.error("duang: running conversations could not be listed before quitting:", error);
  }
  if (busy) {
    const quit = dialog.showMessageBoxSync({
      type: "warning",
      buttons: ["Quit anyway", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "An agent is still working.",
      detail:
        "Quitting stops the run, and nothing resumes it afterwards. Work its tools already finished is not undone.",
    });
    if (quit !== 0) return false;
    // Quitting again while this waits quits at once.
    phase = "stopping";
    quitSends();
    await stopAllRuns();
  }
  const gaveUp = new Promise<false>((resolve) => setTimeout(() => resolve(false), CLOSE_WAIT_MS));
  if (!(await Promise.race([closeAgents().then(() => true), gaveUp])))
    console.error(`duang: the agents had not closed after ${CLOSE_WAIT_MS} ms; quitting cuts them, and the next launch may find an instance still held`);
  return true;
}

app.on("before-quit", (event) => {
  if (phase === "leaving") return;
  if (phase === "stopping") {
    phase = "leaving";
    return;
  }
  event.preventDefault();
  if (phase === "asking") return;
  phase = "asking";
  // Idle agents close in microtasks; calling app.quit() before Emit("before-quit") returns to C++ has its preventDefault clear is_quitting_.
  void readyToQuit().then(
    (go) => {
      phase = go ? "leaving" : "running";
      if (go) setImmediate(() => app.quit());
    },
    (error) => {
      console.error(error);
      phase = "leaving";
      setImmediate(() => app.quit());
    },
  );
});
