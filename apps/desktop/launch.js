// Electron entry of the desktop shell, kept as plain JS so it runs before anything is built.
// Rebuilds the workspace when its output is missing or stale (a shortcut launch has no
// `pnpm desktop` in front of it), then loads the compiled main process from dist/main.js.
// `--create-shortcut` instead writes the Windows Start Menu shortcut and exits.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, shell } from "electron";
import { buildReason, markBuilt } from "../../scripts/start.js";

/** Ties the window to the shortcut, so a pinned taskbar button groups with the running app. */
const APP_USER_MODEL_ID = "blackwall.desktop";
const DESKTOP = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DESKTOP, "../..");
const ICON = join(DESKTOP, "icons", process.platform === "win32" ? "icon.ico" : "icon.png");
const BUILD_LOG_LINES = 30;

const BUILDING_PAGE = `<!doctype html><meta charset="utf-8"><title>blackwall</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0a0918;
color:#c9c6e8;font:14px system-ui,sans-serif;-webkit-app-region:drag">
Building blackwall&hellip;</body>`;

/** Runs `pnpm build` without a console window; resolves with its exit code and output. */
function runBuild() {
  return new Promise((resolve) => {
    // `shell` resolves pnpm's .cmd shim on Windows.
    const child = spawn("pnpm build", { cwd: ROOT, shell: true, windowsHide: true });
    let output = "";
    const collect = (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => resolve({ code: 1, output: `${output}${error.message}\n` }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

async function build() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 320,
    height: 120,
    frame: false,
    resizable: false,
    backgroundColor: "#0a0918",
    icon: ICON,
  });
  void win.loadURL(`data:text/html,${encodeURIComponent(BUILDING_PAGE)}`);
  const { code, output } = await runBuild();
  win.destroy();
  if (code !== 0) {
    const tail = output.trimEnd().split(/\r?\n/).slice(-BUILD_LOG_LINES).join("\n");
    dialog.showErrorBox("blackwall could not be built", tail || `pnpm build exited with ${code}.`);
    app.exit(1);
    return false;
  }
  markBuilt();
  return true;
}

async function createShortcut() {
  await app.whenReady();
  if (process.platform !== "win32") {
    console.error("--create-shortcut is only supported on Windows.");
    app.exit(1);
    return;
  }
  const path = join(app.getPath("appData"), "Microsoft/Windows/Start Menu/Programs/blackwall.lnk");
  const ok = shell.writeShortcutLink(path, "create", {
    // Through pnpm's stable link, not the versioned store path, so Electron upgrades keep it working.
    target: join(DESKTOP, "node_modules/electron/dist/electron.exe"),
    args: `"${DESKTOP}"`,
    cwd: ROOT,
    description: "Open blackwall",
    icon: ICON,
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID,
  });
  console.log(ok ? `Created ${path}` : `Could not create ${path}`);
  app.exit(ok ? 0 : 1);
}

async function run() {
  if (process.argv.includes("--create-shortcut")) return createShortcut();
  // A second launch only focuses the running app (dist/main.js handles it); never rebuild under it.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);
  // Closing the build window must not quit the app; dist/main.js keeps the same no-op.
  app.on("window-all-closed", () => undefined);
  const reason = buildReason(ROOT);
  if (reason) {
    console.log(`Build output is ${reason}; building...`);
    if (!(await build())) return;
  }
  await import("./dist/main.js");
}

run().catch((error) => {
  dialog.showErrorBox(
    "blackwall could not start",
    error instanceof Error ? error.message : String(error),
  );
  app.exit(1);
});
