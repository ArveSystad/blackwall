// Electron main process of the desktop shell: forks the server on system Node,
// shows its launch URL in a window, and owns the tray, the badge and quitting.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_NAME,
  needsYouCountFromTitle,
  voiceHotkeySchema,
  type VoiceHotkey,
} from "@blackwall/shared";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  screen,
  shell,
  systemPreferences,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { SERVER_ENTRY, startChild, type ServerChild } from "./child.js";
import { routeUrl } from "./external-url.js";
import { resolveLoginEnv } from "./login-env.js";
import { checkNode, MIN_NODE_MAJOR } from "./node.js";
import { desktopPort, isPortFree } from "./port.js";
import { createHotkeyTracker, sameHotkey } from "./push-to-talk-hotkey.js";
import { createQuitFlow } from "./quit-flow.js";
import { titleBarOverlay } from "./title-bar.js";
import { loadBounds, saveBounds, visibleBounds, type Bounds } from "./window-state.js";

type Env = Record<string, string | undefined>;

const icon = (name: string) => fileURLToPath(new URL(`../icons/${name}`, import.meta.url));
const windowIcon = icon(process.platform === "win32" ? "icon.ico" : "icon.png");
const DEFAULT_BOUNDS = { width: 1280, height: 860 };
const SAVE_BOUNDS_DELAY_MS = 500;

let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let child: ServerChild | undefined;
/** Set once the server is up, for restarting it after a crash. */
let launch: { nodePath: string; port: number; env: Env } | undefined;

/** Whether the system-wide hold-to-talk hook runs, and why not; mirrors the page's `PttStatus`. */
interface PttStatus {
  active: boolean;
  reason: string | null;
}

type Uiohook = typeof import("uiohook-napi");

let currentHotkey: VoiceHotkey | null = null;
let pttStatus: PttStatus = { active: false, reason: null };
/** The macOS Accessibility prompt is shown at most once per run. */
let prompted = false;
/** The keyboard hook and its tracker, loaded with the first hotkey. */
let hook:
  { uIOhook: Uiohook["uIOhook"]; tracker: ReturnType<typeof createHotkeyTracker> } | undefined;
let hookLoadError: string | undefined;
let hookRunning = false;

const flow = createQuitFlow({
  requestStatus: async (timeoutMs) => child?.requestStatus(timeoutMs),
  confirm: async ({ message, detail }) => {
    const options = {
      type: "question" as const,
      buttons: ["Quit", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message,
      ...(detail ? { detail } : {}),
    };
    if (!win) return (await dialog.showMessageBox(options)).response === 0;
    showWindow();
    return (await dialog.showMessageBox(win, options)).response === 0;
  },
  shutdownChild: async (timeoutMs) => (child ? child.shutdown(timeoutMs) : "exited"),
  kill: () => child?.kill(),
  quit: () => {
    stopHook();
    app.quit();
  },
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Startup cannot continue: tell the user and exit without the quit prompt. */
function fatal(message: string, detail: string): void {
  dialog.showErrorBox(message, detail);
  child?.kill();
  app.exit(1);
}

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function requestQuit(event?: { preventDefault(): void }): void {
  if (flow.quitting) return;
  event?.preventDefault();
  void flow.request();
}

/** Starts the server child and resolves its launch URL; a crash after that offers a restart. */
async function startServer(options: { nodePath: string; port: number; env: Env }) {
  const started = startChild({ ...options, entry: SERVER_ENTRY });
  child = started;
  let ready = false;
  started.onExit((code) => {
    // A requested shutdown (or the kill after its timeout) is not a crash.
    if (ready && !flow.stopping && child === started) void offerRestart(code);
  });
  const { launchUrl } = await started.ready;
  ready = true;
  return launchUrl;
}

async function offerRestart(code: number | null): Promise<void> {
  const options = {
    type: "error" as const,
    buttons: ["Restart", "Quit"],
    defaultId: 0,
    cancelId: 1,
    message: "The blackwall server stopped unexpectedly.",
    detail: `It exited with code ${code}.`,
  };
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  if (flow.stopping) return;
  if (response !== 0 || !launch) {
    void flow.force();
    return;
  }
  try {
    const launchUrl = await startServer(launch);
    await win?.loadURL(launchUrl);
  } catch (error) {
    fatal("blackwall could not start", errorMessage(error));
  }
}

const ACCESSIBILITY_REASON =
  "Allow blackwall under System Settings → Privacy & Security → Accessibility";

function setPttStatus(next: PttStatus): PttStatus {
  pttStatus = next;
  win?.webContents.send("bw:ptt-status", next);
  return next;
}

function stopHook(): void {
  if (!hook || !hookRunning) return;
  hook.uIOhook.stop();
  hookRunning = false;
}

/** Loads `uiohook-napi` once and feeds its key events to the tracker; null when it cannot load. */
async function loadHook(): Promise<typeof hook> {
  if (hook || hookLoadError) return hook;
  try {
    const { uIOhook, UiohookKey } = await import("uiohook-napi");
    const tracker = createHotkeyTracker({
      keycodes: UiohookKey,
      emit: (edge) => win?.webContents.send("bw:ptt", edge),
    });
    uIOhook.on("keydown", (event) => tracker.keydown(event));
    uIOhook.on("keyup", (event) => tracker.keyup(event));
    hook = { uIOhook, tracker };
  } catch (error) {
    hookLoadError = errorMessage(error);
  }
  return hook;
}

/**
 * Registers the hold-to-talk key system-wide (null turns it off). The same key
 * again is a no-op once it works, so a reloaded page re-registering costs nothing.
 */
async function setPushToTalkHotkey(next: VoiceHotkey | null): Promise<PttStatus> {
  if (sameHotkey(next, currentHotkey) && (pttStatus.active || !next)) return pttStatus;
  currentHotkey = next;
  hook?.tracker.set(next);
  if (!next) {
    stopHook();
    return setPttStatus({ active: false, reason: null });
  }
  if (process.platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(false)) {
    if (!prompted) {
      prompted = true;
      systemPreferences.isTrustedAccessibilityClient(true);
    }
    return setPttStatus({ active: false, reason: ACCESSIBILITY_REASON });
  }
  const loaded = await loadHook();
  // Another call may have changed the key while the module loaded.
  if (!sameHotkey(next, currentHotkey)) return pttStatus;
  if (!loaded) {
    return setPttStatus({
      active: false,
      reason: `The system-wide key hook could not load: ${hookLoadError}`,
    });
  }
  loaded.tracker.set(next);
  if (!hookRunning) {
    try {
      loaded.uIOhook.start();
      hookRunning = true;
    } catch (error) {
      return setPttStatus({
        active: false,
        reason: `The system-wide key hook could not start: ${errorMessage(error)}`,
      });
    }
  }
  return setPttStatus({ active: true, reason: null });
}

/** The page's bridge (`preload.cts`); only the app's own origin may use it. */
function handlePushToTalkIpc(appOrigin: string): void {
  const fromApp = (event: IpcMainInvokeEvent) =>
    routeUrl(event.senderFrame?.url ?? "", appOrigin) === "app";
  ipcMain.handle("bw:ptt-hotkey", (event, value: unknown) => {
    if (!fromApp(event)) throw new Error("Not allowed");
    return setPushToTalkHotkey(voiceHotkeySchema.nullable().parse(value));
  });
  ipcMain.handle("bw:ptt-status", (event) => {
    if (!fromApp(event)) throw new Error("Not allowed");
    return pttStatus;
  });
}

function updateBadge(count: number): void {
  tray?.setToolTip(count > 0 ? `${APP_NAME}: ${count} need you` : APP_NAME);
  if (process.platform === "win32") {
    win?.setOverlayIcon(
      count > 0 ? nativeImage.createFromPath(icon("overlay.png")) : null,
      count > 0 ? `${count} need you` : "",
    );
  } else {
    app.setBadgeCount(count);
  }
}

function createWindow(launchUrl: string, port: number): BrowserWindow {
  const stateFile = join(app.getPath("userData"), "window-state.json");
  const saved = visibleBounds(
    loadBounds(stateFile),
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const window = new BrowserWindow({
    ...(saved ?? DEFAULT_BOUNDS),
    title: APP_NAME,
    icon: windowIcon,
    backgroundColor: "#0a0918",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: process.platform === "darwin" ? true : titleBarOverlay(null),
    webPreferences: {
      partition: "persist:blackwall",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      // The system-wide hold-to-talk key records while the window is in the background.
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  let saveTimer: NodeJS.Timeout | undefined;
  const save = () => {
    clearTimeout(saveTimer);
    const bounds: Bounds = window.getNormalBounds();
    saveBounds(stateFile, bounds);
  };
  const saveLater = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_BOUNDS_DELAY_MS);
  };
  window.on("resize", saveLater);
  window.on("move", saveLater);
  window.on("close", (event) => {
    save();
    requestQuit(event);
  });
  // Windows: the session is ending and cannot be held up; stop the agents without asking.
  window.on("session-end", () => void flow.force());

  // Localhost on the fixed port; everything else leaves the window.
  const appOrigin = `http://127.0.0.1:${port}`;
  window.webContents.setWindowOpenHandler(({ url }) => {
    const route = routeUrl(url, appOrigin);
    if (route === "external") void shell.openExternal(url);
    if (route === "app") void window.loadURL(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => {
    const route = routeUrl(event.url, appOrigin);
    if (route === "app") return;
    event.preventDefault();
    if (route === "external") void shell.openExternal(event.url);
  });
  window.on("page-title-updated", (_event, title) => updateBadge(needsYouCountFromTitle(title)));
  // The page drives the button colours through its `theme-color` meta tag.
  window.webContents.on("did-change-theme-color", (_event, color) => {
    if (process.platform !== "darwin") window.setTitleBarOverlay(titleBarOverlay(color));
  });

  void window.loadURL(launchUrl);
  return window;
}

function createTray(): Tray {
  const image =
    process.platform === "darwin"
      ? icon("trayTemplate.png")
      : icon(process.platform === "win32" ? "icon.ico" : "tray.png");
  const created = new Tray(image);
  created.setToolTip(APP_NAME);
  created.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open blackwall", click: showWindow },
      { type: "separator" },
      { label: "Quit", click: () => requestQuit() },
    ]),
  );
  // macOS opens the menu on click; Windows and Linux show the window.
  if (process.platform !== "darwin") created.on("click", showWindow);
  return created;
}

async function startup(): Promise<void> {
  if (process.platform === "darwin") app.dock?.setIcon(icon("icon.png"));

  const env = await resolveLoginEnv();
  const node = checkNode(env);
  if (!node.ok) {
    fatal(
      `blackwall needs Node.js ${MIN_NODE_MAJOR} or newer on PATH`,
      node.version
        ? `Found Node.js ${node.version}. Install Node.js ${MIN_NODE_MAJOR}+ and start blackwall again.`
        : `No node executable was found on PATH. Install Node.js ${MIN_NODE_MAJOR}+ and start blackwall again.`,
    );
    return;
  }

  let port: number;
  try {
    port = desktopPort(env);
  } catch (error) {
    fatal("blackwall could not start", errorMessage(error));
    return;
  }
  if (!(await isPortFree(port))) {
    fatal(
      `Port ${port} is already in use`,
      `Something else is listening on 127.0.0.1:${port}. Stop it, or set BLACKWALL_DESKTOP_PORT to a free port.`,
    );
    return;
  }

  launch = { nodePath: node.path, port, env };
  let launchUrl: string;
  try {
    launchUrl = await startServer(launch);
  } catch (error) {
    fatal("blackwall could not start", errorMessage(error));
    return;
  }
  handlePushToTalkIpc(`http://127.0.0.1:${port}`);
  win = createWindow(launchUrl, port);
  tray = createTray();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", (event) => requestQuit(event));
  // The quit flow owns quitting on every OS, including closing the last window.
  app.on("window-all-closed", () => undefined);
  // Ctrl+C on `pnpm desktop`: stop the agents without asking.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void flow.force());
  void app.whenReady().then(() => {
    // macOS and Linux: the OS is shutting down; delay it and stop the agents without asking.
    powerMonitor.on("shutdown", (event?: { preventDefault(): void }) => {
      event?.preventDefault();
      void flow.force();
    });
    return startup().catch((error: unknown) =>
      fatal("blackwall could not start", errorMessage(error)),
    );
  });
}
