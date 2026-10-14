import type { Connection, ConnectionView } from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";
import { SecretStoreError, type SecretStore } from "./secret-store.js";

export const TOKEN_ENV_PREFIX = "BLACKWALL_TOKEN_";

/**
 * Env var that overrides the keychain token for a connection, derived from its
 * name: `acme.ghe.com` → `BLACKWALL_TOKEN_ACME_GHE_COM`.
 */
export function tokenEnvVar(connectionName: string): string {
  const suffix = connectionName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${TOKEN_ENV_PREFIX}${suffix}`;
}

export class ConnectionNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Connection ${id} not found`);
    this.name = "ConnectionNotFoundError";
  }
}

export type TokenSource = "env" | "keychain";

export interface ConnectionTokensOptions {
  store: SecretStore;
  connections: Repositories["connections"];
  env?: Readonly<Record<string, string | undefined>>;
}

export type ConnectionTokens = ReturnType<typeof createConnectionTokens>;

/**
 * Connection tokens: env overrides win over the keychain. SQLite only records
 * whether a keychain token is set (`tokenSet`); the API sees `hasToken` via
 * `view`, never the token.
 */
export function createConnectionTokens({
  store,
  connections,
  env = process.env,
}: ConnectionTokensOptions) {
  function fromEnv(connection: Pick<Connection, "name">): string | undefined {
    const value = env[tokenEnvVar(connection.name)]?.trim();
    return value ? value : undefined;
  }

  function existing(id: string): Connection {
    const connection = connections.get(id);
    if (!connection) throw new ConnectionNotFoundError(id);
    return connection;
  }

  function source(connection: Connection): TokenSource | null {
    if (fromEnv(connection) !== undefined) return "env";
    return connection.tokenSet ? "keychain" : null;
  }

  function view(connection: Connection): ConnectionView {
    const { id, name, kind, baseUrl, authMeta, createdAt, updatedAt } = connection;
    return {
      id,
      name,
      kind,
      baseUrl,
      authMeta,
      createdAt,
      updatedAt,
      hasToken: hasToken(connection),
    };
  }

  /** Whether a token is available, without touching the keychain. */
  function hasToken(connection: Connection): boolean {
    return source(connection) !== null;
  }

  return {
    source,
    hasToken,
    view,
    list: (): ConnectionView[] => connections.list().map(view),
    /** The token for server-side use only (HTTP clients, agent env). Never return it from the API. */
    async get(connection: Connection): Promise<string | undefined> {
      return fromEnv(connection) ?? (await store.get(connection.id));
    },
    async set(id: string, token: string): Promise<ConnectionView> {
      existing(id);
      await store.set(id, token);
      return view(connections.update(id, { tokenSet: true }));
    },
    /**
     * Re-reads whether the keychain holds a token for the connection, e.g.
     * after a data import; an unusable keychain counts as no token.
     */
    async refresh(id: string): Promise<ConnectionView> {
      existing(id);
      let tokenSet: boolean;
      try {
        tokenSet = (await store.get(id)) !== undefined;
      } catch (error) {
        if (!(error instanceof SecretStoreError)) throw error;
        tokenSet = false;
      }
      return view(connections.update(id, { tokenSet }));
    },
    async delete(id: string): Promise<ConnectionView> {
      existing(id);
      await store.delete(id);
      return view(connections.update(id, { tokenSet: false }));
    },
  };
}
