import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { createMemorySecretStore, type SecretStore } from "../secrets/secret-store.js";
import { createConnectionTokens } from "../secrets/tokens.js";
import {
  InvalidConnectionError,
  MissingCredentialError,
  createConnectionService,
  type ConnectionService,
} from "./service.js";

const TOKEN = "ghp_supersecret123";

let opened: OpenedDatabase;
let r: Repositories;
let store: SecretStore;
let service: ConnectionService;

function build(env: Record<string, string> = {}) {
  const tokens = createConnectionTokens({ store, connections: r.connections, env });
  return createConnectionService({ connections: r.connections, tokens });
}

beforeEach(() => {
  opened = openDatabase(":memory:");
  r = createRepositories(opened.db);
  store = createMemorySecretStore();
  service = build();
});

afterEach(() => opened.close());

const ghe = { name: "acme.ghe.com", kind: "github", baseUrl: "https://acme.ghe.com" } as const;
const jira = {
  name: "acme",
  kind: "jira",
  baseUrl: "https://acme.atlassian.net",
  authMeta: { email: "me@acme.test" },
} as const;

describe("connection service", () => {
  it("creates connections with normalized base URLs and an optional token", async () => {
    const github = await service.create({ ...ghe, baseUrl: "https://ACME.ghe.com/" });
    expect(github).toMatchObject({ baseUrl: "https://acme.ghe.com", hasToken: false });

    const created = await service.create({ ...jira, token: TOKEN });
    expect(created.hasToken).toBe(true);
    expect(await store.get(created.id)).toBe(TOKEN);
    expect(JSON.stringify(r.connections.list())).not.toContain(TOKEN);
  });

  it("validates input", async () => {
    await expect(service.create({ ...jira, authMeta: {} })).rejects.toThrow(
      "Jira connections need the account email",
    );
    await service.create(ghe);
    await expect(service.create(ghe)).rejects.toThrow(InvalidConnectionError);
    await expect(
      service.create({ ...ghe, name: "other", baseUrl: "https://acme.ghe.com/x" }),
    ).rejects.toThrow("A GitHub connection for acme.ghe.com already exists");
    // The same host may serve one connection of each kind.
    await expect(
      service.create({ ...jira, name: "ghe jira", baseUrl: "https://acme.ghe.com" }),
    ).resolves.toMatchObject({ kind: "jira" });
  });

  it("updates fields but keeps Jira connections valid", async () => {
    const created = await service.create(jira);
    expect(service.update(created.id, { name: "Acme" }).name).toBe("Acme");
    expect(() => service.update(created.id, { authMeta: {} })).toThrow(InvalidConnectionError);
    expect(() => service.update("nope", { name: "x" })).toThrow("Connection nope not found");
  });

  it("deletes a connection together with its token", async () => {
    const created = await service.create({ ...ghe, token: TOKEN });
    await service.delete(created.id);
    expect(service.list()).toEqual([]);
    expect(await store.get(created.id)).toBeUndefined();
  });

  it("resolves git remotes and Jira URLs by host", async () => {
    const github = await service.create(ghe);
    const site = await service.create(jira);
    expect(service.resolve({ kind: "github", remote: "git@acme.ghe.com:a/b.git" })?.id).toBe(
      github.id,
    );
    expect(service.resolve({ kind: "github", remote: "https://github.com/a/b" })).toBeUndefined();
    expect(
      service.resolve({ kind: "jira", url: "https://acme.atlassian.net/browse/X-1" })?.id,
    ).toBe(site.id);
    expect(() => service.resolve({ kind: "github", remote: "/srv/repo" })).toThrow(
      InvalidConnectionError,
    );
  });

  it("requires a credential, reporting the host and connection when missing", async () => {
    const target = { kind: "github", remote: "https://acme.ghe.com/a/b.git" } as const;

    const none = await service.requireCredential(target).catch((error: unknown) => error);
    expect(none).toBeInstanceOf(MissingCredentialError);
    expect(none).toMatchObject({ kind: "github", host: "acme.ghe.com", connectionId: null });

    const created = await service.create(ghe);
    const noToken = await service.requireCredential(target).catch((error: unknown) => error);
    expect(noToken).toMatchObject({ host: "acme.ghe.com", connectionId: created.id });

    await service.setToken(created.id, TOKEN);
    const credential = await service.requireCredential(target);
    expect(credential.token).toBe(TOKEN);
    expect(credential.connection.id).toBe(created.id);
  });

  it("accepts an env override as the credential", async () => {
    const created = await service.create(ghe);
    const withEnv = build({ BLACKWALL_TOKEN_ACME_GHE_COM: "from-env" });
    expect((await withEnv.credentialById(created.id)).token).toBe("from-env");
  });
});
