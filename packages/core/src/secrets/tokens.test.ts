import { connectionViewSchema } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { createMemorySecretStore, SecretStoreError, type SecretStore } from "./secret-store.js";
import { createConnectionTokens, tokenEnvVar } from "./tokens.js";

const TOKEN = "ghp_supersecret123";

let opened: OpenedDatabase;
let r: Repositories;
let store: SecretStore;

beforeEach(() => {
  opened = openDatabase(":memory:");
  r = createRepositories(opened.db);
  store = createMemorySecretStore();
});

afterEach(() => opened.close());

function seed() {
  return r.connections.create({
    name: "acme.ghe.com",
    kind: "github",
    baseUrl: "https://acme.ghe.com",
  });
}

describe("tokenEnvVar", () => {
  it.each([
    ["acme.ghe.com", "BLACKWALL_TOKEN_ACME_GHE_COM"],
    ["My Jira", "BLACKWALL_TOKEN_MY_JIRA"],
    ["-github-", "BLACKWALL_TOKEN_GITHUB"],
  ])("maps %j to %s", (name, envVar) => {
    expect(tokenEnvVar(name)).toBe(envVar);
  });
});

describe("connection tokens", () => {
  it("sets, gets and deletes a keychain token, keyed by connection id", async () => {
    const conn = seed();
    const tokens = createConnectionTokens({ store, connections: r.connections, env: {} });

    expect(tokens.hasToken(conn)).toBe(false);
    expect(await tokens.get(conn)).toBeUndefined();

    const view = await tokens.set(conn.id, TOKEN);
    expect(view.hasToken).toBe(true);
    expect(await store.get(conn.id)).toBe(TOKEN);
    const stored = r.connections.get(conn.id)!;
    expect(stored.tokenSet).toBe(true);
    expect(tokens.source(stored)).toBe("keychain");
    expect(await tokens.get(stored)).toBe(TOKEN);

    expect((await tokens.delete(conn.id)).hasToken).toBe(false);
    expect(await store.get(conn.id)).toBeUndefined();
    expect(r.connections.get(conn.id)!.tokenSet).toBe(false);
  });

  it("prefers the env override over the keychain", async () => {
    const conn = seed();
    const env = { BLACKWALL_TOKEN_ACME_GHE_COM: " from-env " };
    const tokens = createConnectionTokens({ store, connections: r.connections, env });

    expect(tokens.source(conn)).toBe("env");
    expect(tokens.view(conn).hasToken).toBe(true);
    expect(await tokens.get(conn)).toBe("from-env");

    await tokens.set(conn.id, TOKEN);
    expect(await tokens.get(r.connections.get(conn.id)!)).toBe("from-env");
  });

  it("ignores an empty env override", async () => {
    const conn = seed();
    const env = { BLACKWALL_TOKEN_ACME_GHE_COM: "  " };
    const tokens = createConnectionTokens({ store, connections: r.connections, env });
    expect(tokens.hasToken(conn)).toBe(false);
  });

  it("never stores or exposes the token outside the secret store", async () => {
    const conn = seed();
    const tokens = createConnectionTokens({ store, connections: r.connections, env: {} });
    await tokens.set(conn.id, TOKEN);

    const views = tokens.list();
    expect(views).toHaveLength(1);
    expect(() => connectionViewSchema.parse(views[0])).not.toThrow();
    expect(JSON.stringify(views)).not.toContain(TOKEN);
    expect(JSON.stringify(r.connections.list())).not.toContain(TOKEN);
  });

  it("rejects unknown connections", async () => {
    const tokens = createConnectionTokens({ store, connections: r.connections, env: {} });
    await expect(tokens.set("nope", TOKEN)).rejects.toThrow("Connection nope not found");
    expect(await store.get("nope")).toBeUndefined();
  });

  it("refreshes tokenSet from the keychain", async () => {
    const tokens = createConnectionTokens({ store, connections: r.connections, env: {} });
    const withToken = seed();
    const without = r.connections.create({
      name: "jira",
      kind: "jira",
      baseUrl: "https://acme.atlassian.net",
    });
    await store.set(withToken.id, TOKEN);
    r.connections.update(without.id, { tokenSet: true });

    expect((await tokens.refresh(withToken.id)).hasToken).toBe(true);
    expect(r.connections.get(withToken.id)?.tokenSet).toBe(true);
    expect((await tokens.refresh(without.id)).hasToken).toBe(false);
    expect(r.connections.get(without.id)?.tokenSet).toBe(false);
  });

  it("treats an unusable keychain as no token on refresh", async () => {
    const failing: SecretStore = {
      ...store,
      get: (account) => Promise.reject(new SecretStoreError("get", account)),
    };
    const tokens = createConnectionTokens({ store: failing, connections: r.connections, env: {} });
    const connection = r.connections.update(seed().id, { tokenSet: true });
    expect((await tokens.refresh(connection.id)).hasToken).toBe(false);
  });
});
