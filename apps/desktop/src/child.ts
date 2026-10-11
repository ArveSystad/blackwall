import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseDesktopChildMessage,
  type DesktopChildMessage,
  type DesktopMainMessage,
} from "@blackwall/shared";
import type { ShutdownResult } from "./quit-flow.js";

type Env = Readonly<Record<string, string | undefined>>;

/** The server's desktop entry, built by `tsc -b` next to this package. */
export const SERVER_ENTRY = fileURLToPath(
  new URL("../../server/dist/desktop-entry.js", import.meta.url),
);

export interface ChildReady {
  launchUrl: string;
  port: number;
}

export interface ServerChild {
  /** Resolves once the server listens; rejects with its `failed` message or an early exit. */
  ready: Promise<ChildReady>;
  /** Running agent count, or `undefined` when the child does not answer within `timeoutMs`. */
  requestStatus(timeoutMs: number): Promise<number | undefined>;
  /** Asks the child to stop its agents and exit. */
  shutdown(timeoutMs: number): Promise<ShutdownResult>;
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
}

/**
 * The child's environment. `--port` is passed explicitly, so the browser-mode
 * port variables are dropped: a stale `BLACKWALL_WEB_PORT` in the user's shell
 * would otherwise fail config validation. `BLACKWALL_HOME` is kept.
 */
export function childEnv(env: Env): Record<string, string | undefined> {
  const result = { ...env };
  delete result.BLACKWALL_PORT;
  delete result.BLACKWALL_WEB_PORT;
  for (const name of Object.keys(result)) if (name.startsWith("ELECTRON_")) delete result[name];
  return result;
}

/** Forks the server on system Node (its `better-sqlite3` is built for that ABI, not Electron's). */
export function startChild(options: {
  nodePath: string;
  entry: string;
  port: number;
  env: Env;
}): ServerChild {
  const child = fork(options.entry, ["--port", String(options.port), "--no-open"], {
    execPath: options.nodePath,
    execArgv: [],
    env: childEnv(options.env),
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  let exited = false;
  const messageListeners = new Set<(message: DesktopChildMessage) => void>();
  const exitListeners = new Set<(code: number | null) => void>();

  const ready = new Promise<ChildReady>((resolve, reject) => {
    messageListeners.add((message) => {
      if (message.type === "ready") resolve({ launchUrl: message.launchUrl, port: message.port });
      if (message.type === "failed") reject(new Error(message.message));
    });
    exitListeners.add((code) => reject(new Error(`server exited with code ${code}`)));
    // `on`, not `once`: a later IPC error must not crash the main process as an unhandled event.
    child.on("error", reject);
  });
  // Callers await `ready`; this only keeps a later rejection from being reported as unhandled.
  ready.catch(() => undefined);

  child.on("message", (value) => {
    const message = parseDesktopChildMessage(value);
    if (message) for (const listener of [...messageListeners]) listener(message);
  });
  child.once("exit", (code) => {
    exited = true;
    for (const listener of [...exitListeners]) listener(code);
  });

  function send(message: DesktopMainMessage): boolean {
    if (exited || !child.connected) return false;
    try {
      child.send(message);
      return true;
    } catch {
      return false;
    }
  }

  /** Resolves with the first of: a matching message, the child's exit, or the timeout. */
  function waitFor<T>(
    timeoutMs: number,
    onMessage: (message: DesktopChildMessage) => T | undefined,
    onExit: T,
    onTimeout: T,
  ): Promise<T> {
    return new Promise((resolve) => {
      const done = (value: T) => {
        clearTimeout(timer);
        messageListeners.delete(messageListener);
        exitListeners.delete(exitListener);
        resolve(value);
      };
      const messageListener = (message: DesktopChildMessage) => {
        const value = onMessage(message);
        if (value !== undefined) done(value);
      };
      const exitListener = () => done(onExit);
      const timer = setTimeout(() => done(onTimeout), timeoutMs);
      messageListeners.add(messageListener);
      exitListeners.add(exitListener);
    });
  }

  return {
    ready,
    async requestStatus(timeoutMs) {
      if (!send({ type: "status" })) return undefined;
      return waitFor<number | undefined>(
        timeoutMs,
        (message) => (message.type === "status" ? message.runningAgents : undefined),
        undefined,
        undefined,
      );
    },
    async shutdown(timeoutMs) {
      if (exited) return "exited";
      const result = waitFor<ShutdownResult>(
        timeoutMs,
        (message) => (message.type === "stopped" ? "stopped" : undefined),
        "exited",
        "timeout",
      );
      // A closed channel also makes the child shut down (its `disconnect` handler).
      if (!send({ type: "shutdown" }) && child.connected) child.disconnect();
      return result;
    },
    kill() {
      if (!exited) child.kill("SIGKILL");
    },
    onExit(listener) {
      exitListeners.add(listener);
    },
  };
}
