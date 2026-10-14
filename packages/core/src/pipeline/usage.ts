import type { Step } from "@blackwall/shared";
import type { AgentUsage } from "../agents/adapters/types.js";

/** A step's usage columns. */
export type StepUsageColumns = Pick<
  Step,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "costUsd"
>;

export function emptyStepUsage(): StepUsageColumns {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
  };
}

export function usageOf(step: Step): StepUsageColumns {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd } = step;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd };
}

/** `total` plus one model call's streamed usage; the cost only when the call reported one. */
export function addUsage(total: StepUsageColumns, call: AgentUsage): StepUsageColumns {
  return {
    inputTokens: total.inputTokens + call.inputTokens,
    outputTokens: total.outputTokens + call.outputTokens,
    cacheReadTokens: total.cacheReadTokens + call.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + call.cacheWriteTokens,
    costUsd: call.costUsd === undefined ? total.costUsd : (total.costUsd ?? 0) + call.costUsd,
  };
}

/**
 * An attempt's usage once its result arrived. The streamed `usage` events are
 * a lower bound for Claude (each carries its message's start-of-call usage, and
 * a sub-agent's last call is not streamed) while its result covers the whole
 * session; OpenCode's result is exactly the events' sum. So each token field
 * takes the larger of the two. The cost is the events' when they carried one
 * (OpenCode), else the result's (Claude).
 */
export function reconcile(
  attempt: StepUsageColumns,
  result: AgentUsage,
  eventsHadCost: boolean,
): StepUsageColumns {
  return {
    inputTokens: Math.max(attempt.inputTokens, result.inputTokens),
    outputTokens: Math.max(attempt.outputTokens, result.outputTokens),
    cacheReadTokens: Math.max(attempt.cacheReadTokens, result.cacheReadTokens),
    cacheWriteTokens: Math.max(attempt.cacheWriteTokens, result.cacheWriteTokens),
    costUsd: eventsHadCost ? attempt.costUsd : (result.costUsd ?? attempt.costUsd),
  };
}

/** The usage of two spans together; the cost is null only when neither reported one. */
export function combine(a: StepUsageColumns, b: StepUsageColumns): StepUsageColumns {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}
