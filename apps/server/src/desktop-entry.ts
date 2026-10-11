// Server entry for the desktop shell (`apps/desktop`). The Electron main process forks this on
// system Node and talks to it over IPC (`@blackwall/shared` desktop messages).
import { parseDesktopMainMessage, type DesktopChildMessage } from "@blackwall/shared";
import { parseConfig } from "./config.js";
import { startBlackwall, type RunningBlackwall } from "./start.js";

let running: RunningBlackwall | undefined;
let pendingShutdown = false;
let stopping = false;

function send(message: DesktopChildMessage, callback?: () => void): void {
  if (!process.connected) {
    callback?.();
    return;
  }
  process.send!(message, undefined, {}, () => callback?.());
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await running?.shutdown();
  // Exits once `stopped` is flushed, so the main process sees it before the exit.
  send({ type: "stopped" }, () => process.exit(0));
}

process.on("message", (value) => {
  const message = parseDesktopMainMessage(value);
  if (!message) return;
  switch (message.type) {
    case "status":
      send({ type: "status", runningAgents: running?.runningAgents() ?? 0 });
      break;
    case "shutdown":
      if (running) void stop();
      else pendingShutdown = true;
      break;
  }
});

// Ctrl+C on `pnpm desktop` reaches this process too; the main process sends `shutdown` instead.
process.on("SIGINT", () => undefined);

// An orphaned child must not keep the port: shut down when the main process goes away.
process.on("disconnect", () => {
  if (running) void stop();
  else pendingShutdown = true;
});

try {
  const config = parseConfig(process.argv.slice(2), process.env);
  running = await startBlackwall(config);
  if (pendingShutdown) {
    await stop();
  } else {
    console.error(`blackwall (desktop) is running at ${running.launchUrl}`);
    send({ type: "ready", launchUrl: running.launchUrl, port: running.port });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  send({ type: "failed", message }, () => process.exit(1));
}
