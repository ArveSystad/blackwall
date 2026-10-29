import type { DataImportResult, DataImportTable, RepoConflict } from "@blackwall/shared";

/** The tables the summary names, in order, with their singular and plural nouns. */
const SUMMARY_TABLES: [DataImportTable, string, string][] = [
  ["tasks", "task", "tasks"],
  ["runs", "run", "runs"],
  ["backlogItems", "backlog item", "backlog items"],
  ["chatMessages", "chat message", "chat messages"],
  ["memories", "memory", "memories"],
  ["repos", "repository", "repositories"],
  ["agents", "agent", "agents"],
  ["connections", "connection", "connections"],
  ["tags", "tag", "tags"],
];

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "a", "a and b", "a, b and c". */
function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * One sentence on what an import added and skipped, e.g. "Imported 12 tasks,
 * 30 runs and 8 memories; skipped 140 existing rows."
 */
export function importSummary(counts: DataImportResult["counts"]): string {
  const imported = SUMMARY_TABLES.flatMap(([table, one, many]) =>
    counts[table].imported > 0 ? [count(counts[table].imported, one, many)] : [],
  );
  const skipped = Object.values(counts).reduce((sum, c) => sum + c.skipped, 0);
  const skippedText = `skipped ${count(skipped, "existing row", "existing rows")}`;
  if (imported.length === 0) return `Nothing new to import; ${skippedText}.`;
  return `Imported ${joinAnd(imported)}; ${skippedText}.`;
}

/** Why the user has to decide on an imported repo. */
export function conflictReason(conflict: Pick<RepoConflict, "kind">): string {
  return conflict.kind === "different-path"
    ? "Same remote, different folder"
    : "Same folder, different remote";
}
