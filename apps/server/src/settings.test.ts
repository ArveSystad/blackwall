import {
  createRepositories,
  createSettingsService,
  openDatabase,
  type OpenedDatabase,
} from "@blackwall/core";
import { DEFAULT_TAGS, generalSettingsSchema } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";

const launchToken = "test-token";
const port = 4711;
const host = `127.0.0.1:${port}`;
const cookie = `${tokenCookieName(port)}=${launchToken}`;

let opened: OpenedDatabase;
let app: ReturnType<typeof createApp>["app"];

beforeEach(() => {
  opened = openDatabase(":memory:");
  const repositories = createRepositories(opened.db);
  repositories.tags.replace(DEFAULT_TAGS);
  const settings = createSettingsService({
    settings: repositories.settings,
    tags: repositories.tags,
  });
  app = createApp({ token: launchToken, getPort: () => port, settings }).app;
});

afterEach(() => opened.close());

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`http://${host}${path}`, {
    method: init.method ?? "GET",
    headers: { host, cookie, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

describe("tag routes", () => {
  it("lists the tags in order", async () => {
    expect(await (await request("/api/tags")).json()).toEqual([...DEFAULT_TAGS]);
  });

  it("replaces the list", async () => {
    const res = await request("/api/tags", { method: "PUT", body: { tags: ["ux", "security"] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["ux", "security"]);
    expect(await (await request("/api/tags")).json()).toEqual(["ux", "security"]);
  });

  it("rejects an invalid list", async () => {
    const res = await request("/api/tags", { method: "PUT", body: { tags: ["ux", "ux"] } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Each tag can be listed only once" });
  });
});

describe("settings routes", () => {
  it("returns the default concurrency cap", async () => {
    const res = await request("/api/settings");
    expect(generalSettingsSchema.parse(await res.json())).toEqual({ maxTasksPerRepo: 3 });
  });

  it("updates the concurrency cap", async () => {
    const res = await request("/api/settings", { method: "PATCH", body: { maxTasksPerRepo: 6 } });
    expect(await res.json()).toEqual({ maxTasksPerRepo: 6 });
    expect(await (await request("/api/settings")).json()).toEqual({ maxTasksPerRepo: 6 });
  });

  it("rejects an out-of-range cap", async () => {
    const res = await request("/api/settings", { method: "PATCH", body: { maxTasksPerRepo: 0 } });
    expect(res.status).toBe(400);
  });
});
