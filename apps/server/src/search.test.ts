import {
  createRepositories,
  createSearch,
  openDatabase,
  type OpenedDatabase,
  type Repositories,
} from "@blackwall/core";
import { searchResultsSchema } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";

const token = "test-token";
const port = 4711;
const host = `127.0.0.1:${port}`;
const cookie = `${tokenCookieName(port)}=${token}`;

let opened: OpenedDatabase;
let repositories: Repositories;
let app: ReturnType<typeof createApp>["app"];
let appId: string;

beforeEach(() => {
  opened = openDatabase(":memory:");
  repositories = createRepositories(opened.db);
  appId = repositories.repos.create({ path: "/code/app", name: "app" }).id;
  const apiId = repositories.repos.create({ path: "/code/api", name: "api" }).id;
  const origin = { kind: "free-text" } as const;
  repositories.tasks.create({ title: "Fix login", origin, repoId: appId });
  repositories.tasks.create({ title: "Login api", origin, repoId: apiId });
  repositories.backlogItems.insert({ title: "Login tests", origin, repoId: appId });
  app = createApp({ token, getPort: () => port, search: createSearch(opened.db) }).app;
});

afterEach(() => opened.close());

function request(query: string) {
  return app.request(`http://${host}/api/search?${query}`, { headers: { host, cookie } });
}

describe("GET /api/search", () => {
  it("returns grouped results", async () => {
    const res = await request("q=login");
    expect(res.status).toBe(200);
    const results = searchResultsSchema.parse(await res.json());
    expect(results.tasks).toHaveLength(2);
    expect(results.backlogItems.map((i) => i.title)).toEqual(["Login tests"]);
    expect(results.repos).toEqual([]);
  });

  it("filters to the repo under repo scope", async () => {
    const res = await request(`q=login&repoId=${appId}&scope=repo`);
    const results = searchResultsSchema.parse(await res.json());
    expect(results.tasks.map((t) => t.title)).toEqual(["Fix login"]);
  });

  it("rejects an unknown scope", async () => {
    const res = await request("q=login&scope=everywhere");
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
  });
});
