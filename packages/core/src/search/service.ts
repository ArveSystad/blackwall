import { and, asc, desc, eq, ne, or, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type {
  SearchBacklogHit,
  SearchRepoHit,
  SearchResults,
  SearchScope,
  SearchTaskHit,
} from "@blackwall/shared";
import type { Db } from "../db/database.js";
import { backlogItems, repos, tasks } from "../db/schema.js";

/** Most hits per group. */
export const SEARCH_LIMIT = 20;

/** Shorter queries return nothing. */
export const MIN_QUERY_CHARS = 2;

/** Escapes LIKE's wildcards (and the escape character) so they match literally. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * About `width` characters of `text` around the first case-insensitive match
 * of `needle`, whitespace collapsed and `…` where cut; null when it does not
 * match.
 */
export function snippetAround(text: string, needle: string, width = 100): string | null {
  const flat = collapse(text);
  const target = collapse(needle).toLowerCase();
  if (!target) return null;
  const at = flat.toLowerCase().indexOf(target);
  if (at === -1) return null;
  let start = Math.max(0, at - Math.floor((width - target.length) / 2));
  const end = Math.min(flat.length, start + width);
  start = Math.max(0, end - width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

/** The first snippet among `texts`, unless the title matches. */
function snippetFor(title: string, texts: (string | null)[], needle: string): string | null {
  if (title.toLowerCase().includes(needle.toLowerCase())) return null;
  for (const text of texts) {
    const snippet = text ? snippetAround(text, needle) : null;
    if (snippet) return snippet;
  }
  return null;
}

export interface SearchInput {
  q: string;
  /** The current repo: listed first, and the only one searched under `repo` scope. */
  repoId?: string | undefined;
  scope?: SearchScope | undefined;
}

/**
 * Global search over tasks (archived included), waiting and paused backlog
 * items and repo names: plain case-insensitive (ASCII) LIKE, the current repo
 * first and each group capped at {@link SEARCH_LIMIT}.
 */
export function createSearch(db: Db) {
  return {
    search({ q, repoId, scope = "all" }: SearchInput): SearchResults {
      const needle = q.trim();
      if (needle.length < MIN_QUERY_CHARS) return { tasks: [], backlogItems: [], repos: [] };
      const pattern = `%${escapeLike(needle)}%`;
      const like = (column: AnySQLiteColumn) => sql`${column} LIKE ${pattern} ESCAPE '\\'`;
      const onlyRepo = scope === "repo" && repoId !== undefined;
      const inScope = (column: AnySQLiteColumn): SQL | undefined =>
        onlyRepo ? eq(column, repoId) : undefined;
      const currentFirst = (column: AnySQLiteColumn): SQL[] =>
        repoId === undefined ? [] : [sql`CASE WHEN ${column} = ${repoId} THEN 0 ELSE 1 END`];

      const taskRows = db
        .select({
          id: tasks.id,
          title: tasks.title,
          repoId: tasks.repoId,
          repoName: repos.name,
          status: tasks.status,
          archivedAt: tasks.archivedAt,
          origin: tasks.origin,
          freeText: tasks.freeText,
          summary: tasks.summary,
          shortSummary: tasks.shortSummary,
        })
        .from(tasks)
        .innerJoin(repos, eq(tasks.repoId, repos.id))
        .where(
          and(
            or(
              like(tasks.title),
              like(tasks.freeText),
              like(tasks.summary),
              like(tasks.shortSummary),
            ),
            inScope(tasks.repoId),
          ),
        )
        .orderBy(
          ...currentFirst(tasks.repoId),
          sql`${tasks.archivedAt} IS NOT NULL`,
          desc(tasks.updatedAt),
        )
        .limit(SEARCH_LIMIT)
        .all();

      const itemRows = db
        .select({
          id: backlogItems.id,
          title: backlogItems.title,
          repoId: backlogItems.repoId,
          repoName: repos.name,
          status: backlogItems.status,
          origin: backlogItems.origin,
          freeText: backlogItems.freeText,
        })
        .from(backlogItems)
        .innerJoin(repos, eq(backlogItems.repoId, repos.id))
        .where(
          and(
            ne(backlogItems.status, "promoted"),
            or(like(backlogItems.title), like(backlogItems.freeText)),
            inScope(backlogItems.repoId),
          ),
        )
        .orderBy(...currentFirst(backlogItems.repoId), desc(backlogItems.updatedAt))
        .limit(SEARCH_LIMIT)
        .all();

      const repoRows: SearchRepoHit[] = db
        .select({ id: repos.id, name: repos.name, path: repos.path })
        .from(repos)
        .where(and(like(repos.name), inScope(repos.id)))
        .orderBy(
          ...currentFirst(repos.id),
          desc(repos.favorite),
          asc(repos.position),
          asc(repos.name),
        )
        .limit(SEARCH_LIMIT)
        .all();

      return {
        tasks: taskRows.map((row): SearchTaskHit => ({
          id: row.id,
          title: row.title,
          repoId: row.repoId,
          repoName: row.repoName,
          status: row.status,
          archived: row.archivedAt !== null,
          origin: row.origin,
          snippet: snippetFor(row.title, [row.freeText, row.summary, row.shortSummary], needle),
        })),
        backlogItems: itemRows.map((row): SearchBacklogHit => ({
          id: row.id,
          title: row.title,
          repoId: row.repoId,
          repoName: row.repoName,
          // Promoted items are filtered out above.
          status: row.status === "paused" ? "paused" : "waiting",
          origin: row.origin,
          snippet: snippetFor(row.title, [row.freeText], needle),
        })),
        repos: repoRows,
      };
    },
  };
}

export type Search = ReturnType<typeof createSearch>;
