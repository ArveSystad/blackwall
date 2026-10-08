import {
  JIRA_EMAIL_META,
  MISSING_CREDENTIAL_STATUS,
  STALE_REPO_STATUS,
  WS_PATH,
  agentSchema,
  connectionTestResultSchema,
  connectionViewSchema,
  generalSettingsSchema,
  healthResponseSchema,
  missingCredentialSchema,
  repoScanResultSchema,
  repoSchema,
  repoViewSchema,
  roleAgentsSchema,
  staleRepoSchema,
  tagListInputSchema,
  taskSchema,
  type Agent,
  type AgentInput,
  type AgentUpdate,
  type ConnectionTestResult,
  type ConnectionView,
  type GeneralSettings,
  type GeneralSettingsUpdate,
  type HealthResponse,
  type MissingCredential,
  type ResolveConnectionInput,
  type Repo,
  type RepoInput,
  type RepoScanInput,
  type RepoScanResult,
  type RepoUpdate,
  type RepoView,
  type RoleAgents,
  type StaleRepo,
  type Task,
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

interface RequestInit {
  method?: string;
  body?: unknown;
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    ...(init.body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
  });
  if (!res.ok) throw await errorFrom(res);
  return res;
}

async function request<T>(
  path: string,
  schema: { parse(value: unknown): T },
  init: RequestInit = {},
): Promise<T> {
  return schema.parse(await (await send(path, init)).json());
}

/** A request answered with 204 No Content. */
async function requestEmpty(path: string, init: RequestInit): Promise<void> {
  await send(path, init);
}

const at = (base: string, id: string) => `${base}/${encodeURIComponent(id)}`;

export function listTasks(): Promise<Task[]> {
  return request("/api/tasks", taskSchema.array());
}

export function getTask(id: string): Promise<Task> {
  return request(`/api/tasks/${encodeURIComponent(id)}`, taskSchema);
}

export function listRepos(): Promise<RepoView[]> {
  return request("/api/repos", repoViewSchema.array());
}

export function addRepo(input: RepoInput): Promise<Repo> {
  return request("/api/repos", repoSchema, { method: "POST", body: input });
}

/** Registers every git repo under a root folder. */
export function scanRepos(input: RepoScanInput): Promise<RepoScanResult> {
  return request("/api/repos/scan", repoScanResultSchema, { method: "POST", body: input });
}

export function updateRepo(id: string, patch: RepoUpdate): Promise<Repo> {
  return request(at("/api/repos", id), repoSchema, { method: "PATCH", body: patch });
}

export function deleteRepo(id: string): Promise<void> {
  return requestEmpty(at("/api/repos", id), { method: "DELETE" });
}

/** Re-reads the repo's origin remote and its connection; a missing folder is a `StaleRepoError`. */
export function refreshRepo(id: string): Promise<Repo> {
  return request(`${at("/api/repos", id)}/refresh`, repoSchema, { method: "POST" });
}

/** Check commands suggested from the repo's build files; a missing folder is a `StaleRepoError`. */
export function suggestedChecks(id: string): Promise<string[]> {
  return request(`${at("/api/repos", id)}/suggested-checks`, repoSchema.shape.checkCommands);
}

export function listAgents(): Promise<Agent[]> {
  return request("/api/agents", agentSchema.array());
}

export function createAgent(input: AgentInput): Promise<Agent> {
  return request("/api/agents", agentSchema, { method: "POST", body: input });
}

export function updateAgent(id: string, patch: AgentUpdate): Promise<Agent> {
  return request(at("/api/agents", id), agentSchema, { method: "PATCH", body: patch });
}

export function deleteAgent(id: string): Promise<void> {
  return requestEmpty(at("/api/agents", id), { method: "DELETE" });
}

export function getRoleDefaults(): Promise<RoleAgents> {
  return request("/api/agents/role-defaults", roleAgentsSchema);
}

export function setRoleDefaults(roles: RoleAgents): Promise<RoleAgents> {
  return request("/api/agents/role-defaults", roleAgentsSchema, { method: "PUT", body: roles });
}

export function listTags(): Promise<string[]> {
  return request("/api/tags", tagListInputSchema.shape.tags);
}

export function setTags(tags: string[]): Promise<string[]> {
  return request("/api/tags", tagListInputSchema.shape.tags, { method: "PUT", body: { tags } });
}

export function getSettings(): Promise<GeneralSettings> {
  return request("/api/settings", generalSettingsSchema);
}

export function updateSettings(patch: GeneralSettingsUpdate): Promise<GeneralSettings> {
  return request("/api/settings", generalSettingsSchema, { method: "PATCH", body: patch });
}

export function listConnections(): Promise<ConnectionView[]> {
  return request("/api/connections", connectionViewSchema.array());
}

export function deleteConnection(id: string): Promise<void> {
  return requestEmpty(at("/api/connections", id), { method: "DELETE" });
}

/** Removes the connection's keychain token (an env override, if set, still applies). */
export function forgetToken(id: string): Promise<ConnectionView> {
  return request(`${at("/api/connections", id)}/token`, connectionViewSchema, {
    method: "DELETE",
  });
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
