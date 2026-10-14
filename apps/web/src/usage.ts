import type { Usage } from "@blackwall/shared";

/** Usage added up over steps. */
export interface UsageTotal {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** All four token counts. */
  tokens: number;
  /** Null when no step reported a cost. */
  costUsd: number | null;
  /** Some steps reported a cost and some did not, so `costUsd` is a lower bound. */
  costPartial: boolean;
}

export function sumUsage(rows: readonly Usage[]): UsageTotal {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd: number | null = null;
  let withoutCost = 0;
  for (const row of rows) {
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    cacheReadTokens += row.cacheReadTokens;
    cacheWriteTokens += row.cacheWriteTokens;
    if (row.costUsd === null) withoutCost += 1;
    else costUsd = (costUsd ?? 0) + row.costUsd;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    tokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd,
    costPartial: costUsd !== null && withoutCost > 0,
  };
}

/** A token count, short: `950`, `12.3k`, `1.2M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_950) return `${trim((n / 1000).toFixed(1))}k`;
  return `${trim((n / 1_000_000).toFixed(1))}M`;
}

const trim = (fixed: string) => fixed.replace(/\.0$/, "");

/** A cost: `$0.42`, `<$0.01`, `≥ $0.42` when some steps reported none, `n/a` when none did. */
export function formatCost(total: Pick<UsageTotal, "costUsd" | "costPartial">): string {
  if (total.costUsd === null) return "n/a";
  const cost =
    total.costUsd > 0 && total.costUsd < 0.01 ? "<$0.01" : `$${total.costUsd.toFixed(2)}`;
  return total.costPartial ? `≥ ${cost}` : cost;
}

/** The tooltip breaking a total down. */
export function usageTitle(total: UsageTotal): string {
  const lines = [
    `Input: ${total.inputTokens.toLocaleString("en-US")}`,
    `Output: ${total.outputTokens.toLocaleString("en-US")}`,
    `Cache read: ${total.cacheReadTokens.toLocaleString("en-US")}`,
    `Cache write: ${total.cacheWriteTokens.toLocaleString("en-US")}`,
  ];
  if (total.costUsd === null) lines.push("No cost reported by the CLI");
  else if (total.costPartial) lines.push("Some steps ran on a CLI that doesn't report cost");
  return lines.join("\n");
}
