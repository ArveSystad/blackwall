import { quitPrompt, type QuitPrompt } from "./quit-prompt.js";

/** How the server child ended: it confirmed the shutdown, it had already exited, or it hung. */
export type ShutdownResult = "stopped" | "exited" | "timeout";

export interface QuitFlowDeps {
  /** Running agent count, or `undefined` when the child does not answer within `timeoutMs`. */
  requestStatus(timeoutMs: number): Promise<number | undefined>;
  /** Shows the quit prompt; resolves true when the user confirms. */
  confirm(prompt: QuitPrompt): Promise<boolean>;
  shutdownChild(timeoutMs: number): Promise<ShutdownResult>;
  kill(): void;
  quit(): void;
}

export interface QuitFlow {
  /** Asks the user, then stops the child and quits. A no-op while a prompt or a stop is underway. */
  request(): Promise<void>;
  /** Stops the child and quits without asking (session end, OS shutdown). */
  force(): Promise<void>;
  /** True from the moment the stop sequence starts. */
  readonly stopping: boolean;
  /** True once the child is gone, right before `quit()`: quit events must pass through. */
  readonly quitting: boolean;
}

export const STATUS_TIMEOUT_MS = 1000;
export const SHUTDOWN_TIMEOUT_MS = 15_000;

type Phase = "idle" | "prompting" | "stopping" | "quitting";

export function createQuitFlow(deps: QuitFlowDeps): QuitFlow {
  let phase: Phase = "idle";
  let stopPromise: Promise<void> | undefined;

  function stop(): Promise<void> {
    // Set before the first await, so a child exit during shutdown is never taken for a crash.
    phase = "stopping";
    stopPromise = (async () => {
      const result = await deps.shutdownChild(SHUTDOWN_TIMEOUT_MS);
      if (result === "timeout") deps.kill();
      phase = "quitting";
      deps.quit();
    })();
    return stopPromise;
  }

  return {
    async request() {
      if (phase !== "idle") return;
      phase = "prompting";
      const count = await deps.requestStatus(STATUS_TIMEOUT_MS);
      const ok = await deps.confirm(quitPrompt(count));
      // A `force()` took over while the prompt was open.
      if (phase !== "prompting") return;
      if (!ok) {
        phase = "idle";
        return;
      }
      await stop();
    },
    force() {
      return stopPromise ?? stop();
    },
    get stopping() {
      return phase === "stopping" || phase === "quitting";
    },
    get quitting() {
      return phase === "quitting";
    },
  };
}
