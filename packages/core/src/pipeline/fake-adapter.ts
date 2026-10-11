import type { AgentCli } from "@blackwall/shared";
import {
  AgentRunError,
  emptyUsage,
  type AgentAdapter,
  type AgentEvent,
  type AgentResult,
  type AgentRun,
  type AgentRunOptions,
} from "../agents/adapters/types.js";

/** How one fake run behaves. */
export interface FakeScript {
  /** Final text; default `"ok"`. */
  text?: string;
  structured?: unknown;
  /** Defaults to the resumed session, else a fresh `fake-<n>`. */
  sessionId?: string;
  /** Emit the session event, then wait until aborted. */
  hang?: boolean;
  /** Fail with this message instead of producing a result. */
  fail?: string;
  /**
   * Hit the usage limit: emit a `rate-limit` event (with this reset time, ISO,
   * when given), then fail like a CLI that stopped on it.
   */
  rateLimit?: { resetsAt?: string };
  /** The resumed session is gone: fail like Claude's `No conversation found`. */
  missingSession?: boolean;
}

export interface FakeCall {
  cli: AgentCli;
  options: AgentRunOptions;
}

export interface FakeAdapter extends AgentAdapter {
  readonly calls: FakeCall[];
}

/**
 * An in-process {@link AgentAdapter} for tests: each run emits a session
 * event, a message and a result as `script` dictates, and honours abort like
 * the real adapters (rejecting with an `aborted` {@link AgentRunError}).
 */
export function createFakeAdapter(
  cli: AgentCli,
  script: (options: AgentRunOptions, call: number) => FakeScript = () => ({}),
): FakeAdapter {
  const calls: FakeCall[] = [];
  let sessions = 0;

  return {
    cli,
    calls,
    run(options): AgentRun {
      calls.push({ cli, options });
      const plan = script(options, calls.length - 1);
      const sessionId = plan.sessionId ?? options.resumeSessionId ?? `fake-${++sessions}`;
      const events: AgentEvent[] = [];
      let wake: (() => void) | undefined;
      let finished = false;
      const emit = (event: AgentEvent) => {
        events.push(event);
        wake?.();
      };
      const end = () => {
        finished = true;
        wake?.();
      };

      const result = new Promise<AgentResult>((resolve, reject) => {
        const abort = () => {
          emit({ type: "error", message: "Run aborted" });
          reject(new AgentRunError("aborted", "Run aborted", "", null));
          end();
        };
        if (options.signal?.aborted) return abort();
        if (plan.missingSession) {
          // Like Claude, a lost session fails before any session event.
          const message = `No conversation found with session ID: ${sessionId}`;
          emit({ type: "error", message });
          reject(new AgentRunError("session-missing", message, "", 1));
          return end();
        }
        emit({ type: "session", sessionId });
        if (plan.hang) {
          options.signal?.addEventListener("abort", abort, { once: true });
          return;
        }
        // Settle on a later tick, like a real process.
        setImmediate(() => {
          if (plan.rateLimit) {
            const message = "Claude AI usage limit reached";
            emit({ type: "rate-limit", ...plan.rateLimit });
            emit({ type: "error", message });
            reject(new AgentRunError("cli-error", message, "", 1));
          } else if (plan.fail !== undefined) {
            emit({ type: "error", message: plan.fail });
            reject(new AgentRunError("cli-error", plan.fail, "", 1));
          } else {
            const text = plan.text ?? "ok";
            const final: AgentResult = {
              sessionId,
              text,
              usage: emptyUsage(),
              ...(plan.structured !== undefined ? { structured: plan.structured } : {}),
            };
            emit({ type: "message", text });
            emit({ type: "result", result: final });
            resolve(final);
          }
          end();
        });
      });
      result.catch(() => undefined);

      return {
        result,
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const event = events.shift();
            if (event) {
              yield event;
              continue;
            }
            if (finished) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
          }
        },
      };
    },
  };
}
