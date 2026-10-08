import {
  JIRA_EMAIL_META,
  MISSING_CREDENTIAL_STATUS,
  STALE_REPO_STATUS,
  WS_PATH,
  connectionTestResultSchema,
  connectionViewSchema,
  healthResponseSchema,
  missingCredentialSchema,
  parseServerEvent,
  staleRepoSchema,
  type ClientEvent,
  type ConnectionTestResult,
  type ConnectionView,
  type HealthResponse,
  type MissingCredential,
  type ResolveConnectionInput,
  type ServerEvent,
  type StaleRepo,
} from "@blackwall/shared";

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch("/api/health", signal ? { signal } : {});
  if (!res.ok) throw new Error(`Health check failed (${res.status})`);
  return healthResponseSchema.parse(await res.json());
}

/** A failed API call. `message` is the server's error text, safe to show. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The action needs a connection or token that is not configured (see `MissingTokenModal`). */
export class MissingCredentialError extends ApiError {
  constructor(readonly missing: MissingCredential) {
    super(MISSING_CREDENTIAL_STATUS, missing.message);
    this.name = "MissingCredentialError";
  }
}

/** The action used a repo whose folder is gone; `message` is the warning to show. */
export class StaleRepoError extends ApiError {
  constructor(readonly stale: StaleRepo) {
    super(STALE_REPO_STATUS, stale.message);
    this.name = "StaleRepoError";
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => undefined);
  if (res.status === MISSING_CREDENTIAL_STATUS) {
    const missing = missingCredentialSchema.safeParse(body);
    if (missing.success) return new MissingCredentialError(missing.data);
  }
  if (res.status === STALE_REPO_STATUS) {
    const stale = staleRepoSchema.safeParse(body);
    if (stale.success) return new StaleRepoError(stale.data);
  }
  const message =
    body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `Request failed (${res.status})`;
  return new ApiError(res.status, message);
}

async function request<T>(
  path: string,
  schema: { parse(value: unknown): T },
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    ...(init.body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
  });
  if (!res.ok) throw await errorFrom(res);
  return schema.parse(await res.json());
}

export function listConnections(): Promise<ConnectionView[]> {
  return request("/api/connections", connectionViewSchema.array());
}

/** The connection for a git remote or Jira URL; throws `MissingCredentialError` without a token. */
export function resolveConnection(target: ResolveConnectionInput): Promise<ConnectionView> {
  return request("/api/connections/resolve", connectionViewSchema, {
    method: "POST",
    body: target,
  });
}

export function testConnection(id: string): Promise<ConnectionTestResult> {
  return request(`/api/connections/${encodeURIComponent(id)}/test`, connectionTestResultSchema, {
    method: "POST",
  });
}

export interface CredentialInput {
  token: string;
  /** Jira account email; needed only when a Jira connection is created. */
  email?: string;
}

/**
 * Stores the token a `MissingCredential` asked for: on the existing connection,
 * or on a new connection for the host (named after it) when there is none.
 */
export function saveCredential(
  missing: MissingCredential,
  { token, email }: CredentialInput,
): Promise<ConnectionView> {
  if (missing.connectionId) {
    return request(
      `/api/connections/${encodeURIComponent(missing.connectionId)}/token`,
      connectionViewSchema,
      { method: "PUT", body: { token } },
    );
  }
  return request("/api/connections", connectionViewSchema, {
    method: "POST",
    body: {
      name: missing.host,
      kind: missing.kind,
      baseUrl: `https://${missing.host}`,
      authMeta: missing.kind === "jira" ? { [JIRA_EMAIL_META]: email ?? "" } : {},
      token,
    },
  });
}

/**
 * Runs `action`; when it fails with `MissingCredentialError`, asks for the
 * credential via `prompt` and retries once it is saved. A cancelled prompt
 * rethrows the error.
 */
export async function runWithCredential<T>(
  action: () => Promise<T>,
  prompt: (missing: MissingCredential) => Promise<boolean>,
): Promise<T> {
  for (;;) {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof MissingCredentialError)) throw error;
      if (!(await prompt(error.missing))) throw error;
    }
  }
}

export function socketUrl(location: Pick<Location, "protocol" | "host">): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${WS_PATH}`;
}

export interface Socket {
  send(event: ClientEvent): void;
  close(): void;
}

/** Opens the typed event socket; invalid server messages are dropped. */
export function connectSocket(handlers: {
  onOpen?: () => void;
  onEvent: (event: ServerEvent) => void;
  onClose?: () => void;
}): Socket {
  const ws = new WebSocket(socketUrl(window.location));
  ws.addEventListener("open", () => handlers.onOpen?.());
  ws.addEventListener("close", () => handlers.onClose?.());
  ws.addEventListener("message", (message) => {
    const event = typeof message.data === "string" ? parseServerEvent(message.data) : null;
    if (event) handlers.onEvent(event);
  });
  return {
    send: (event) => ws.send(JSON.stringify(event)),
    close: () => ws.close(),
  };
}
