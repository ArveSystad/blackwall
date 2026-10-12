import {
  roleAgentsSchema,
  JIRA_EMAIL_META,
  MISSING_CREDENTIAL_STATUS,
  STALE_REPO_STATUS,
  WS_PATH,
  activeAgentStepSchema,
  agentSchema,
  backlogItemSchema,
  backlogItemViewSchema,
  cliStatusSchema,
  connectionTestResultSchema,
  connectionViewSchema,
  deliveryPlanSchema,
  findingSchema,
  generalSettingsSchema,
  grillAnswerResultSchema,
  grillQuestionSchema,
  healthResponseSchema,
  missingCredentialSchema,
  issueLookupSchema,
  pullRequestLookupSchema,
  quotaStateSchema,
  repoBacklogRunnerSchema,
  reviewRequestsSchema,
  repoScanResultSchema,
  repoSchema,
  repoSyncSchema,
  repoViewSchema,
  runSchema,
  staleRepoSchema,
  stepEventSchema,
  stepSchema,
  tagListInputSchema,
  taskArtifactSchema,
  taskDiffSchema,
  taskDoneTimeSchema,
  taskSchema,
  type ActiveAgentStep,
  type Agent,
  type AgentInput,
  type AgentUpdate,
  type BacklogItem,
  type BacklogItemView,
  type CliStatus,
  type ConnectionInput,
  type ConnectionTestResult,
  type RepoSync,
  type ConnectionView,
  type DeliveryPlan,
  type Finding,
  type FindingOverride,
  type GateResponseInput,
  type GeneralSettings,
  type GeneralSettingsUpdate,
  type GrillAnswerResult,
  type GrillQuestion,
  type HealthResponse,
  type MissingCredential,
  type NewBacklogItemInput,
  type IssueLookup,
  type PullRequestLookup,
  type QuotaState,
  type RepoBacklogRunner,
  type ResolveConnectionInput,
  type Repo,
  type RepoInput,
  type RepoScanInput,
  type RepoScanResult,
  type RepoUpdate,
  type RepoView,
  type ReviewRequests,
  type RoleAgents,
  type Run,
  type StaleRepo,
  type Step,
  type StepEvent,
  type Task,
  type TaskArtifact,
  type TaskDiff,
  type TaskDoneTime,
  type UpdateBacklogItemInput,
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

/** Resolves a pasted PR link to a task origin and the registered repo it belongs to. */
export function lookupPullRequest(url: string): Promise<PullRequestLookup> {
  return request("/api/pull-requests/lookup", pullRequestLookupSchema, {
    method: "POST",
    body: { url },
  });
}

/** Open PRs waiting on the user's review on every GitHub host, and the hosts that failed. */
export function listReviewRequests(): Promise<ReviewRequests> {
  return request("/api/pull-requests/review-requests", reviewRequestsSchema);
}

export function lookupIssue(url: string): Promise<IssueLookup> {
  return request("/api/issues/lookup", issueLookupSchema, { method: "POST", body: { url } });
}

const taskPath = (id: string) => at("/api/tasks", id);

export function listQuestions(taskId: string): Promise<GrillQuestion[]> {
  return request(`${taskPath(taskId)}/questions`, grillQuestionSchema.array());
}

export function answerQuestion(
  taskId: string,
  questionId: string,
  answer: string,
): Promise<GrillAnswerResult> {
  return request(
    `${taskPath(taskId)}/questions/${encodeURIComponent(questionId)}/answer`,
    grillAnswerResultSchema,
    { method: "POST", body: { answer } },
  );
}

export function listFindings(taskId: string): Promise<Finding[]> {
  return request(`${taskPath(taskId)}/findings`, findingSchema.array());
}

export function overrideFinding(
  taskId: string,
  findingId: string,
  status: FindingOverride,
): Promise<Finding> {
  return request(`${taskPath(taskId)}/findings/${encodeURIComponent(findingId)}`, findingSchema, {
    method: "POST",
    body: { status },
  });
}

/** Answers the gate a needs-you task waits on (approve plan, triage, finish, …). */
export function respondToGate(taskId: string, input: GateResponseInput): Promise<Task> {
  return request(`${taskPath(taskId)}/gate`, taskSchema, { method: "POST", body: input });
}

/** Re-queues an interrupted or failed task. */
export function resumeTask(taskId: string): Promise<Task> {
  return request(`${taskPath(taskId)}/resume`, taskSchema, { method: "POST" });
}

/** Archives a done task: it leaves the Inbox and the backlog lists. */
export function archiveTask(taskId: string): Promise<Task> {
  return request(`${taskPath(taskId)}/archive`, taskSchema, { method: "POST" });
}

/** Lists an archived task again. */
export function unarchiveTask(taskId: string): Promise<Task> {
  return request(`${taskPath(taskId)}/unarchive`, taskSchema, { method: "POST" });
}

/** Stops a queued or running task; it ends interrupted and Resume continues its session. */
export function stopTask(taskId: string): Promise<Task> {
  return request(`${taskPath(taskId)}/stop`, taskSchema, { method: "POST" });
}

/** Deletes an undelivered task with its worktree, local branch and history. */
export function deleteTask(taskId: string): Promise<void> {
  return requestEmpty(taskPath(taskId), { method: "DELETE" });
}

/** What finishing the task would send, action by action. */
export function getDeliveryPlan(taskId: string): Promise<DeliveryPlan> {
  return request(`${taskPath(taskId)}/delivery`, deliveryPlanSchema);
}

/** Every running agent step with its task, oldest first. */
export function listActiveAgents(): Promise<ActiveAgentStep[]> {
  return request("/api/tasks/active-agents", activeAgentStepSchema.array());
}

/** When each done task was resolved. */
export function listDoneTimes(): Promise<TaskDoneTime[]> {
  return request("/api/tasks/done-times", taskDoneTimeSchema.array());
}

export function listRuns(taskId: string): Promise<Run[]> {
  return request(`${taskPath(taskId)}/runs`, runSchema.array());
}

export function listSteps(taskId: string, runId: string): Promise<Step[]> {
  return request(`${taskPath(taskId)}/runs/${encodeURIComponent(runId)}/steps`, stepSchema.array());
}

export function listStepEvents(taskId: string, stepId: string): Promise<StepEvent[]> {
  return request(
    `${taskPath(taskId)}/steps/${encodeURIComponent(stepId)}/events`,
    stepEventSchema.array(),
  );
}

/** The task branch's changes per fix round. */
export function listDiffs(taskId: string): Promise<TaskDiff[]> {
  return request(`${taskPath(taskId)}/diffs`, taskDiffSchema.array());
}

/** The images an implementer saved to `.blackwall/artifacts/`, newest first. */
export function listArtifacts(taskId: string): Promise<TaskArtifact[]> {
  return request(`${taskPath(taskId)}/artifacts`, taskArtifactSchema.array());
}

/** An artifact's image URL; `?v=` changes when the file does, so a re-taken screenshot isn't cached. */
export function artifactUrl(taskId: string, artifact: Pick<TaskArtifact, "path" | "modifiedAt">) {
  const path = artifact.path.split("/").map(encodeURIComponent).join("/");
  return `${taskPath(taskId)}/artifacts/${path}?v=${artifact.modifiedAt.getTime()}`;
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

/** Sets the manual order; `ids` must list every repo once. */
export function reorderRepos(ids: string[]): Promise<RepoView[]> {
  return request("/api/repos/reorder", repoViewSchema.array(), {
    method: "POST",
    body: { ids },
  });
}

export function deleteRepo(id: string): Promise<void> {
  return requestEmpty(at("/api/repos", id), { method: "DELETE" });
}

/** Re-reads the repo's origin remote and its connection; a missing folder is a `StaleRepoError`. */
export function refreshRepo(id: string): Promise<Repo> {
  return request(`${at("/api/repos", id)}/refresh`, repoSchema, { method: "POST" });
}

/** Local main vs origin/main as of the last fetch; `null` without both refs. */
export function getRepoSync(id: string): Promise<RepoSync | null> {
  return request(`${at("/api/repos", id)}/sync`, repoSyncSchema.nullable());
}

/** Pushes the repo's local main to origin (the user confirmed); returns the fresh status. */
export function pushRepo(id: string): Promise<RepoSync | null> {
  return request(`${at("/api/repos", id)}/push`, repoSyncSchema.nullable(), { method: "POST" });
}

/** Check commands suggested from the repo's build files; a missing folder is a `StaleRepoError`. */
export function suggestedChecks(id: string): Promise<string[]> {
  return request(`${at("/api/repos", id)}/suggested-checks`, repoSchema.shape.checkCommands);
}

const backlogPath = (repoId: string) => `${at("/api/repos", repoId)}/backlog`;

/** The repo's backlog in pick order, each item with the dependencies still holding it back. */
export function listBacklog(repoId: string): Promise<BacklogItemView[]> {
  return request(backlogPath(repoId), backlogItemViewSchema.array());
}

export function createBacklogItem(
  repoId: string,
  input: NewBacklogItemInput,
): Promise<BacklogItem> {
  return request(backlogPath(repoId), backlogItemSchema, { method: "POST", body: input });
}

/** Edits a waiting or paused item; a promoted item answers 409. */
export function updateBacklogItem(
  repoId: string,
  id: string,
  patch: UpdateBacklogItemInput,
): Promise<BacklogItem> {
  return request(at(backlogPath(repoId), id), backlogItemSchema, { method: "PATCH", body: patch });
}

export function deleteBacklogItem(repoId: string, id: string): Promise<void> {
  return requestEmpty(at(backlogPath(repoId), id), { method: "DELETE" });
}

/** Promotes the item now: the server creates a normal queued task from it. */
export function runBacklogItem(repoId: string, id: string): Promise<Task> {
  return request(`${at(backlogPath(repoId), id)}/run`, taskSchema, { method: "POST" });
}

/** Sets the manual order; `ids` must list every item of the repo once. */
export function reorderBacklog(repoId: string, ids: string[]): Promise<BacklogItem[]> {
  return request(`${backlogPath(repoId)}/reorder`, backlogItemSchema.array(), {
    method: "POST",
    body: { ids },
  });
}

export function getBacklogRunner(repoId: string): Promise<RepoBacklogRunner> {
  return request(`${backlogPath(repoId)}/runner`, repoBacklogRunnerSchema);
}

export function setBacklogRunner(repoId: string, enabled: boolean): Promise<RepoBacklogRunner> {
  return request(`${backlogPath(repoId)}/runner`, repoBacklogRunnerSchema, {
    method: "PATCH",
    body: { enabled },
  });
}

/** Clears a halt so the runner moves on with the backlog. */
export function resumeBacklogRunner(repoId: string): Promise<RepoBacklogRunner> {
  return request(`${backlogPath(repoId)}/runner/resume`, repoBacklogRunnerSchema, {
    method: "POST",
  });
}

/** Usage-limit state per agent CLI. */
export function getQuota(): Promise<QuotaState[]> {
  return request("/api/quota", quotaStateSchema.array());
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

/** The default agent per role. */
export function getRoleDefaults(): Promise<RoleAgents> {
  return request("/api/agents/role-defaults", roleAgentsSchema);
}

/** Replaces the role defaults. */
export function setRoleDefaults(roles: RoleAgents): Promise<RoleAgents> {
  return request("/api/agents/role-defaults", roleAgentsSchema, { method: "PUT", body: roles });
}

/** Agent CLIs found on PATH at server start, with their versions. */
export function listClis(): Promise<CliStatus[]> {
  return request("/api/clis", cliStatusSchema.array());
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

export function createConnection(input: ConnectionInput): Promise<ConnectionView> {
  return request("/api/connections", connectionViewSchema, { method: "POST", body: input });
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
  return createConnection({
    name: missing.host,
    kind: missing.kind,
    baseUrl: `https://${missing.host}`,
    authMeta: missing.kind === "jira" ? { [JIRA_EMAIL_META]: email ?? "" } : {},
    token,
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
