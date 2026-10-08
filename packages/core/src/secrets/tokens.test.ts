import { connectionViewSchema } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { createMemorySecretStore, type SecretStore } from "./secret-store.js";
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
    name: "jbf.ghe.com",
    kind: "github",
    baseUrl: "https://jbf.ghe.com",
  });
}

describe("tokenEnvVar", () => {
  it.each([
    ["jbf.ghe.com", "BLACKWALL_TOKEN_JBF_GHE_COM"],
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
    const env = { BLACKWALL_TOKEN_JBF_GHE_COM: " from-env " };
    const tokens = createConnectionTokens({ store, connections: r.connections, env });

    expect(tokens.source(conn)).toBe("env");
    expect(tokens.view(conn).hasToken).toBe(true);
    expect(await tokens.get(conn)).toBe("from-env");

    await tokens.set(conn.id, TOKEN);
    expect(await tokens.get(r.connections.get(conn.id)!)).toBe("from-env");
  });

  it("ignores an empty env override", async () => {
    const conn = seed();
    const env = { BLACKWALL_TOKEN_JBF_GHE_COM: "  " };
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
});
