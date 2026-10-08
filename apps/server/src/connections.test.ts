import {
  SecretStoreError,
  createConnectionTokens,
  createMemorySecretStore,
  createRepositories,
  openDatabase,
  type OpenedDatabase,
  type SecretStore,
} from "@blackwall/core";
import { connectionViewSchema } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";

const launchToken = "test-token";
const port = 4711;
const host = `127.0.0.1:${port}`;
const cookie = `${tokenCookieName(port)}=${launchToken}`;
const PAT = "ghp_supersecret123";

let opened: OpenedDatabase;
let store: SecretStore;
let connectionId: string;
let app: ReturnType<typeof createApp>["app"];

beforeEach(() => {
  opened = openDatabase(":memory:");
  const repositories = createRepositories(opened.db);
  connectionId = repositories.connections.create({
    name: "jbf.ghe.com",
    kind: "github",
    baseUrl: "https://jbf.ghe.com",
  }).id;
  store = createMemorySecretStore();
  const connectionTokens = createConnectionTokens({
    store,
    connections: repositories.connections,
    env: {},
  });
  app = createApp({ token: launchToken, getPort: () => port, connectionTokens }).app;
});

afterEach(() => opened.close());

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`http://${host}${path}`, {
    method: init.method ?? "GET",
    headers: { host, cookie, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

describe("connection routes", () => {
  it("stores a token in the secret store and only reports hasToken", async () => {
    const put = await request(`/api/connections/${connectionId}/token`, {
      method: "PUT",
      body: { token: PAT },
    });
    expect(put.status).toBe(200);
    const putText = await put.text();
    expect(putText).not.toContain(PAT);
    expect(connectionViewSchema.parse(JSON.parse(putText)).hasToken).toBe(true);
    expect(await store.get(connectionId)).toBe(PAT);

    const list = await request("/api/connections");
    const listText = await list.text();
    expect(listText).not.toContain(PAT);
    const views = connectionViewSchema.array().parse(JSON.parse(listText));
    expect(views.map((v) => v.hasToken)).toEqual([true]);

    const del = await request(`/api/connections/${connectionId}/token`, { method: "DELETE" });
    expect(connectionViewSchema.parse(await del.json()).hasToken).toBe(false);
    expect(await store.get(connectionId)).toBeUndefined();
  });

  it("rejects a missing token and unknown connections", async () => {
    const empty = await request(`/api/connections/${connectionId}/token`, {
      method: "PUT",
      body: { token: "  " },
    });
    expect(empty.status).toBe(400);
    const unknown = await request("/api/connections/nope/token", {
      method: "PUT",
      body: { token: PAT },
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).not.toContain(PAT);
  });

  it("reports keychain failures without leaking the token", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(store, "set").mockRejectedValue(
      new SecretStoreError("set", connectionId, { cause: new Error(`failed with ${PAT}`) }),
    );
    const res = await request(`/api/connections/${connectionId}/token`, {
      method: "PUT",
      body: { token: PAT },
    });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(PAT);
    expect(JSON.stringify(error.mock.calls)).not.toContain(PAT);
    error.mockRestore();
  });
});
