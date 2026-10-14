// `pnpm desktop`: builds the workspace when its output is missing or stale (like `pnpm start`),
// then runs the Electron shell in apps/desktop. Electron forks the server on the system Node.
// Arguments are passed to the shell (`pnpm desktop:shortcut` adds `--create-shortcut`).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt } from "./start.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "apps/desktop");

ensureBuilt();

// The `electron` package exports the path of its binary (downloaded on first use).
const electron = createRequire(join(DESKTOP, "package.json"))("electron");
// Set, it would make Electron run as plain Node instead of opening a window.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [DESKTOP, ...process.argv.slice(2)], { stdio: "inherit", env });
// Ctrl+C reaches Electron too, which stops the server; wait for it instead of exiting first.
const ignore = () => undefined;
process.on("SIGINT", ignore);
process.on("SIGTERM", ignore);
child.on("exit", (code, signal) => {
  process.off("SIGINT", ignore);
  process.off("SIGTERM", ignore);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
