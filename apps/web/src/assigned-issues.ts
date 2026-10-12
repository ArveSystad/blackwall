import { plural } from "./backlog";

/** The home pill's full label, also its accessible name. */
export function issuePillLabel(count: number): string {
  if (count === 0) return "No issues assigned to you";
  return `${plural(count, "issue")} assigned to you`;
}
