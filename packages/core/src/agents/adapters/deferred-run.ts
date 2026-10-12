import { AgentRunError, type AgentEvent, type AgentResult, type AgentRun } from "./types.js";

/** A run whose events `body` emits and whose result it returns. */
export function emittingRun(
  body: (emit: (event: AgentEvent) => void) => Promise<AgentResult>,
): AgentRun {
  const queue: AgentEvent[] = [];
  let finished = false;
  let wake: (() => void) | undefined;
  const emit = (event: AgentEvent) => {
    queue.push(event);
    wake?.();
  };

  const result = body(emit).finally(() => {
    finished = true;
    wake?.();
  });
  // Callers that only iterate must not trigger an unhandled rejection.
  result.catch(() => undefined);

  return {
    result,
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const event = queue.shift();
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
}

/**
 * A run that starts once `start` resolves and calls `dispose` after it
 * settled, so the run's result only settles once the cleanup is done. `cli`
 * names the CLI in the error when `start` fails.
 */
export function deferredRun(
  cli: string,
  start: () => Promise<{ run: AgentRun; dispose: () => Promise<void> }>,
): AgentRun {
  return emittingRun(async (emit) => {
    let started: Awaited<ReturnType<typeof start>>;
    try {
      started = await start();
    } catch (error) {
      const message = `Could not prepare the ${cli} run: ${(error as Error).message}`;
      emit({ type: "error", message });
      throw new AgentRunError("spawn", message, "", null);
    }
    try {
      for await (const event of started.run) emit(event);
      return await started.run.result;
    } finally {
      await started.dispose();
    }
  });
}
