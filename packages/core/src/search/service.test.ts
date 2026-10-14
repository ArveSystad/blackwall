import { searchResultsSchema } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { SEARCH_LIMIT, createSearch, escapeLike, snippetAround, type Search } from "./service.js";

let opened: OpenedDatabase;
let r: Repositories;
let search: Search;
let app: string;
let api: string;

const freeText = { kind: "free-text" } as const;

beforeEach(() => {
  opened = openDatabase(":memory:");
  r = createRepositories(opened.db);
  search = createSearch(opened.db);
  app = r.repos.create({ path: "/code/app", name: "app" }).id;
  api = r.repos.create({ path: "/code/api", name: "api-server" }).id;
});

afterEach(() => opened.close());

function task(repoId: string, title: string, values: { freeText?: string } & object = {}) {
  return r.tasks.create({ title, origin: freeText, repoId, ...values });
}

function item(repoId: string, title: string, values: { freeText?: string } & object = {}) {
  return r.backlogItems.insert({ title, origin: freeText, repoId, ...values });
}

const ids = (hits: { id: string }[]) => hits.map((h) => h.id);

describe("tasks", () => {
  it("matches the title, free text, summary and short summary", () => {
    const byTitle = task(app, "Fix login");
    const byText = task(app, "One", { freeText: "the login form breaks" });
    const bySummary = task(app, "Two", { summary: "Reworked login handling" });
    const byShort = task(app, "Three", { shortSummary: "login fix" });
    task(app, "Unrelated", { freeText: "nothing here" });
    const results = search.search({ q: "login" });
    expect(new Set(ids(results.tasks))).toEqual(
      new Set([byTitle.id, byText.id, bySummary.id, byShort.id]),
    );
    expect(searchResultsSchema.parse(results)).toEqual(results);
  });

  it("includes archived tasks after the others, flagged", () => {
    const archived = task(app, "Login old", {
      status: "done",
      archivedAt: new Date(),
      updatedAt: new Date(2030, 0, 1),
    });
    const live = task(app, "Login new", { updatedAt: new Date(2020, 0, 1) });
    const hits = search.search({ q: "login" }).tasks;
    expect(ids(hits)).toEqual([live.id, archived.id]);
    expect(hits.map((h) => h.archived)).toEqual([false, true]);
    expect(hits[0]).toMatchObject({ repoId: app, repoName: "app", status: "queued" });
  });

  it("matches ASCII case-insensitively", () => {
    const hit = task(app, "Fix LOGIN");
    expect(ids(search.search({ q: "login" }).tasks)).toEqual([hit.id]);
  });

  it("matches % and _ literally", () => {
    const percent = task(app, "Raise to 100% coverage");
    const underscore = task(app, "Rename user_id");
    task(app, "Rename userXid");
    task(app, "100 coverage");
    expect(ids(search.search({ q: "0%" }).tasks)).toEqual([percent.id]);
    expect(ids(search.search({ q: "r_i" }).tasks)).toEqual([underscore.id]);
  });

  it("sets a snippet for a body match and none for a title match", () => {
    task(app, "Fix login");
    task(app, "Other", { freeText: "Users cannot log in when the\n\nlogin form   is empty" });
    const hits = search.search({ q: "login" }).tasks;
    expect(hits.find((h) => h.title === "Fix login")?.snippet).toBeNull();
    expect(hits.find((h) => h.title === "Other")?.snippet).toBe(
      "Users cannot log in when the login form is empty",
    );
  });

  it("caps the group", () => {
    for (let i = 0; i < SEARCH_LIMIT + 5; i++) task(app, `Login ${i}`);
    expect(search.search({ q: "login" }).tasks).toHaveLength(SEARCH_LIMIT);
  });
});

describe("backlog items", () => {
  it("matches the title and free text, keeps paused items and leaves promoted ones out", () => {
    const byTitle = item(app, "Login tests");
    const byText = item(app, "Other", { freeText: "cover the login form" });
    const paused = item(app, "Paused login", { status: "paused" });
    const promoted = item(app, "Promoted login");
    r.backlogItems.markPromoted(promoted.id, task(app, "Unrelated").id);
    const hits = search.search({ q: "login" }).backlogItems;
    expect(new Set(ids(hits))).toEqual(new Set([byTitle.id, byText.id, paused.id]));
    expect(hits.find((h) => h.id === paused.id)?.status).toBe("paused");
    expect(hits.find((h) => h.id === byText.id)?.snippet).toBe("cover the login form");
  });
});

describe("repos", () => {
  it("matches the name", () => {
    expect(ids(search.search({ q: "API" }).repos)).toEqual([api]);
  });
});

describe("queries and scope", () => {
  it("returns empty groups for an empty or one-character query", () => {
    task(app, "a");
    const empty = { tasks: [], backlogItems: [], repos: [] };
    expect(search.search({ q: "" })).toEqual(empty);
    expect(search.search({ q: " a " })).toEqual(empty);
  });

  it("lists the current repo first under all scope", () => {
    const other = task(api, "Login api", { updatedAt: new Date(2030, 0, 1) });
    const mine = task(app, "Login app", { updatedAt: new Date(2020, 0, 1) });
    const otherItem = item(api, "Login api item");
    const myItem = item(app, "Login app item");
    expect(ids(search.search({ q: "login" }).tasks)).toEqual([other.id, mine.id]);
    const results = search.search({ q: "login", repoId: app, scope: "all" });
    expect(ids(results.tasks)).toEqual([mine.id, other.id]);
    expect(ids(results.backlogItems)).toEqual([myItem.id, otherItem.id]);
    expect(ids(search.search({ q: "ap", repoId: api }).repos)).toEqual([api, app]);
  });

  it("filters to the current repo under repo scope, and searches all without one", () => {
    task(api, "Login api");
    const mine = task(app, "Login app");
    const scoped = search.search({ q: "login", repoId: app, scope: "repo" });
    expect(ids(scoped.tasks)).toEqual([mine.id]);
    expect(search.search({ q: "login", scope: "repo" }).tasks).toHaveLength(2);
  });
});

describe("escapeLike", () => {
  it("escapes the wildcards and the escape character", () => {
    expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  });
});

describe("snippetAround", () => {
  it("returns short text whole", () => {
    expect(snippetAround("fix the login", "LOGIN")).toBe("fix the login");
  });

  it("cuts around a match at the start or end", () => {
    const long = `login ${"x".repeat(200)} logout`;
    expect(snippetAround(long, "login", 20)).toBe(`login ${"x".repeat(14)}…`);
    expect(snippetAround(long, "logout", 20)).toBe(`…${"x".repeat(13)} logout`);
  });

  it("centres a match in the middle", () => {
    const text = `${"a".repeat(100)} needle ${"b".repeat(100)}`;
    const snippet = snippetAround(text, "needle", 20)!;
    expect(snippet).toMatch(/^….*needle.*…$/);
    expect(snippet.length).toBeLessThanOrEqual(22);
  });

  it("returns null without a match", () => {
    expect(snippetAround("fix the login", "logout")).toBeNull();
  });
});
