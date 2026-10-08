import {
  connectionAuthProblem,
  connectionInputSchema,
  connectionUpdateSchema,
  type Connection,
  type ConnectionInput,
  type ConnectionKind,
  type ConnectionUpdate,
  type ConnectionView,
  type ResolveConnectionInput,
} from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";
import { ConnectionNotFoundError, type ConnectionTokens } from "../secrets/tokens.js";
import { gitRemoteHost, normalizeBaseUrl, urlHost } from "./hosts.js";

const KIND_LABELS: Record<ConnectionKind, string> = { github: "GitHub", jira: "Jira" };

/**
 * An action needs a connection or token that is not configured. The server
 * returns it as a `MissingCredential` error; the web app asks for the token.
 */
export class MissingCredentialError extends Error {
  constructor(
    readonly kind: ConnectionKind,
    readonly host: string,
    /** `null` when no connection exists for the host. */
    readonly connectionId: string | null,
  ) {
    super(connectionId ? `No token for ${host}` : `No ${KIND_LABELS[kind]} connection for ${host}`);
    this.name = "MissingCredentialError";
  }
}

/** Rejected connection input (bad fields, duplicate name or host). Safe to show the user. */
export class InvalidConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConnectionError";
  }
}

/** A connection together with its token, for server-side use only. */
export interface Credential {
  connection: Connection;
  token: string;
}

export interface ConnectionServiceOptions {
  connections: Repositories["connections"];
  tokens: ConnectionTokens;
}

export type ConnectionService = ReturnType<typeof createConnectionService>;

function invalid(error: { issues: readonly { message: string }[] }): InvalidConnectionError {
  return new InvalidConnectionError(error.issues.map((issue) => issue.message).join("; "));
}

/** Host a connection serves, from its base URL. */
export function connectionHost(connection: Pick<Connection, "baseUrl">): string {
  return urlHost(connection.baseUrl) ?? connection.baseUrl;
}

/**
 * Connections: CRUD, resolution by host and credential lookup. Each kind has at
 * most one connection per host, so a git remote or Jira URL resolves to exactly
 * one connection.
 */
export function createConnectionService({ connections, tokens }: ConnectionServiceOptions) {
  function existing(id: string): Connection {
    const connection = connections.get(id);
    if (!connection) throw new ConnectionNotFoundError(id);
    return connection;
  }

  function findByHost(kind: ConnectionKind, host: string): Connection | undefined {
    const wanted = host.toLowerCase();
    return connections.list().find((c) => c.kind === kind && connectionHost(c) === wanted);
  }

  /** Rejects a name or host that another connection already uses. */
  function assertUnique(candidate: Pick<Connection, "name" | "kind" | "baseUrl">, id?: string) {
    const others = connections.list().filter((c) => c.id !== id);
    if (others.some((c) => c.name === candidate.name)) {
      throw new InvalidConnectionError(`A connection named ${candidate.name} already exists`);
    }
    const host = connectionHost(candidate);
    if (others.some((c) => c.kind === candidate.kind && connectionHost(c) === host)) {
      throw new InvalidConnectionError(
        `A ${KIND_LABELS[candidate.kind]} connection for ${host} already exists`,
      );
    }
  }

  /**
   * Host an address points at, for resolution: the host of a git remote for
   * GitHub, of a URL (base URL or any issue link) for Jira.
   */
  function hostOf(target: ResolveConnectionInput): string {
    const host = target.kind === "github" ? gitRemoteHost(target.remote) : urlHost(target.url);
    if (!host) throw new InvalidConnectionError("Could not read a host from that address");
    return host;
  }

  async function credentialFor(connection: Connection): Promise<Credential> {
    const token = await tokens.get(connection);
    if (!token)
      throw new MissingCredentialError(connection.kind, connectionHost(connection), connection.id);
    return { connection, token };
  }

  return {
    list: (): ConnectionView[] => tokens.list(),
    get: (id: string): ConnectionView => tokens.view(existing(id)),

    /** Creates a connection; a `token` in the input is stored in the keychain. */
    async create(input: ConnectionInput): Promise<ConnectionView> {
      const parsed = connectionInputSchema.safeParse(input);
      if (!parsed.success) throw invalid(parsed.error);
      const { token, ...fields } = parsed.data;
      const values = { ...fields, baseUrl: normalizeBaseUrl(fields.baseUrl) };
      assertUnique(values);
      const created = connections.create(values);
      if (token === undefined) return tokens.view(created);
      try {
        return await tokens.set(created.id, token);
      } catch (error) {
        // Without its token the connection would only trigger the modal again.
        connections.delete(created.id);
        throw error;
      }
    },

    update(id: string, patch: ConnectionUpdate): ConnectionView {
      const current = existing(id);
      const parsed = connectionUpdateSchema.safeParse(patch);
      if (!parsed.success) throw invalid(parsed.error);
      const next = {
        name: parsed.data.name ?? current.name,
        kind: current.kind,
        baseUrl: normalizeBaseUrl(parsed.data.baseUrl ?? current.baseUrl),
        authMeta: parsed.data.authMeta ?? current.authMeta,
      };
      const problem = connectionAuthProblem(next);
      if (problem) throw new InvalidConnectionError(problem);
      assertUnique(next, id);
      const { name, baseUrl, authMeta } = next;
      return tokens.view(connections.update(id, { name, baseUrl, authMeta }));
    },

    /** Deletes a connection and its keychain token. */
    async delete(id: string): Promise<void> {
      existing(id);
      await tokens.delete(id);
      connections.delete(id);
    },

    setToken: (id: string, token: string): Promise<ConnectionView> => tokens.set(id, token),
    deleteToken: (id: string): Promise<ConnectionView> => tokens.delete(id),

    findByHost,

    hostOf,

    /** Connection for a git remote (GitHub) or Jira URL, by host. */
    resolve(target: ResolveConnectionInput): Connection | undefined {
      return findByHost(target.kind, hostOf(target));
    },

    /** The connection's token; throws `MissingCredentialError` when none is set. */
    credentialFor,

    /** Connection and token by id; throws `MissingCredentialError` when it has no token. */
    credentialById: (id: string): Promise<Credential> => credentialFor(existing(id)),

    /**
     * Connection and token for a git remote or Jira URL; throws
     * `MissingCredentialError` when the host has no connection or no token.
     */
    async requireCredential(target: ResolveConnectionInput): Promise<Credential> {
      const host = hostOf(target);
      const connection = findByHost(target.kind, host);
      if (!connection) throw new MissingCredentialError(target.kind, host, null);
      return credentialFor(connection);
    },
  };
}
