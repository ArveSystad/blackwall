import type { Search } from "@blackwall/core";
import { searchQuerySchema, type SearchResults } from "@blackwall/shared";
import { Hono } from "hono";
import { badRequest } from "./validation.js";

/** Read-only global search over tasks, backlog items and repos, for the Ctrl+K palette. */
export function searchRoutes(search: Pick<Search, "search">): Hono {
  const routes = new Hono();
  routes.get("/", (c) => {
    const input = searchQuerySchema.safeParse(c.req.query());
    if (!input.success) {
      return badRequest(c, input.error.issues);
    }
    return c.json<SearchResults>(search.search(input.data));
  });
  return routes;
}
