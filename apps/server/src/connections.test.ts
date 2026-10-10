import {
  SecretStoreError,
  createConnectionService,
  createConnectionTokens,
  createMemorySecretStore,
  createRepositories,
  openDatabase,
  type OpenedDatabase,
  type SecretStore,
} from "@blackwall/core";
import {
  MISSING_CREDENTIAL_STATUS,
  connectionTestResultSchema,
  connectionViewSchema,
  missingCredentialSchema,
  type Connection,
} from "@blackwall/shared";
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
let tested: { connection: Connection; token: string }[];

beforeEach(() => {
  opened = openDatabase(":memory:");
  const repositories = createRepositories(opened.db);
  connectionId = repositories.connections.create({
    name: "acme.ghe.com",
    kind: "github",
    baseUrl: "https://acme.ghe.com",
  }).id;
  store = createMemorySecretStore();
  const connectionTokens = createConnectionTokens({
    store,
    connections: repositories.connections,
    env: {},
  });
  const connections = createConnectionService({
    connections: repositories.connections,
    tokens: connectionTokens,
  });
  tested = [];
  const test = (connection: Connection, token: string) => {
    tested.push({ connection, token });
    return Promise.resolve({ ok: true as const, account: "octocat" });
  };
  app = createApp({
    token: launchToken,
    getPort: () => port,
    connections: { connections, test },
  }).app;
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

describe("connection CRUD", () => {
  it("creates, reads, updates and deletes a connection", async () => {
    const created = await request("/api/connections", {
      method: "POST",
      body: {
        name: "acme jira",
        kind: "jira",
        baseUrl: "https://acme.atlassian.net/",
        authMeta: { email: "me@acme.test" },
        token: PAT,
      },
    });
    expect(created.status).toBe(201);
    const createdText = await created.text();
    expect(createdText).not.toContain(PAT);
    const view = connectionViewSchema.parse(JSON.parse(createdText));
    expect(view).toMatchObject({ baseUrl: "https://acme.atlassian.net", hasToken: true });
    expect(await store.get(view.id)).toBe(PAT);

    const patched = await request(`/api/connections/${view.id}`, {
      method: "PATCH",
      body: { name: "Acme Jira" },
    });
    expect(connectionViewSchema.parse(await patched.json()).name).toBe("Acme Jira");

    const got = await request(`/api/connections/${view.id}`);
    expect(connectionViewSchema.parse(await got.json()).name).toBe("Acme Jira");

    const del = await request(`/api/connections/${view.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(await store.get(view.id)).toBeUndefined();
    expect((await request(`/api/connections/${view.id}`)).status).toBe(404);
  });

  it("rejects Jira connections without an email and duplicate hosts", async () => {
    const noEmail = await request("/api/connections", {
      method: "POST",
      body: { name: "jira", kind: "jira", baseUrl: "https://acme.atlassian.net" },
    });
    expect(noEmail.status).toBe(400);
    expect(await noEmail.json()).toEqual({ error: "Jira connections need the account email" });

    const duplicate = await request("/api/connections", {
      method: "POST",
      body: { name: "ghe again", kind: "github", baseUrl: "https://ACME.ghe.com/" },
    });
    expect(duplicate.status).toBe(400);
  });
});

describe("test connection", () => {
  it("runs the probe with the stored token", async () => {
    await request(`/api/connections/${connectionId}/token`, {
      method: "PUT",
      body: { token: PAT },
    });
    const res = await request(`/api/connections/${connectionId}/test`, { method: "POST" });
    expect(connectionTestResultSchema.parse(await res.json())).toEqual({
      ok: true,
      account: "octocat",
    });
    expect(tested.map((t) => t.token)).toEqual([PAT]);
  });

  it("answers MissingCredential when the connection has no token", async () => {
    const res = await request(`/api/connections/${connectionId}/test`, { method: "POST" });
    expect(res.status).toBe(MISSING_CREDENTIAL_STATUS);
    expect(missingCredentialSchema.parse(await res.json())).toMatchObject({
      kind: "github",
      host: "acme.ghe.com",
      connectionId,
    });
    expect(tested).toEqual([]);
  });
});

describe("resolve", () => {
  const resolve = (body: unknown) => request("/api/connections/resolve", { method: "POST", body });

  it("resolves a git remote to its GitHub connection once a token is saved", async () => {
    const remote = "git@acme.ghe.com:platform/gateway.git";
    const missing = await resolve({ kind: "github", remote });
    expect(missing.status).toBe(MISSING_CREDENTIAL_STATUS);
    expect(missingCredentialSchema.parse(await missing.json())).toMatchObject({
      host: "acme.ghe.com",
      connectionId,
    });

    // The missing-token modal saves the token, then the action is retried.
    await request(`/api/connections/${connectionId}/token`, {
      method: "PUT",
      body: { token: PAT },
    });
    const retried = await resolve({ kind: "github", remote });
    expect(retried.status).toBe(200);
    expect(connectionViewSchema.parse(await retried.json()).id).toBe(connectionId);
  });

  it("reports an unconfigured host with no connection id, then resolves once created", async () => {
    const url = "https://acme.atlassian.net/browse/BW-1";
    const missing = await resolve({ kind: "jira", url });
    expect(missingCredentialSchema.parse(await missing.json())).toEqual({
      error: "MissingCredential",
      kind: "jira",
      host: "acme.atlassian.net",
      connectionId: null,
      message: "No Jira connection for acme.atlassian.net",
    });

    await request("/api/connections", {
      method: "POST",
      body: {
        name: "acme.atlassian.net",
        kind: "jira",
        baseUrl: "https://acme.atlassian.net",
        authMeta: { email: "me@acme.test" },
        token: PAT,
      },
    });
    const retried = await resolve({ kind: "jira", url });
    expect(retried.status).toBe(200);
    expect(await retried.text()).not.toContain(PAT);
  });

  it("rejects an address without a host", async () => {
    for (const remote of ["C:/code/repo", "/home/me/repo"]) {
      expect((await resolve({ kind: "github", remote })).status).toBe(400);
    }
  });
});
