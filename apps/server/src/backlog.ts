import {
  checkReferenceRepoIds,
  createsDependencyCycle,
  MissingCredentialError,
  sortBacklog,
  unmetDependencies,
  type Repositories,
  type SettingsService,
} from "@blackwall/core";
import type { PullRequestStackMember } from "@blackwall/integrations";
import {
  MAX_TITLE_CHARS,
  newBacklogItemInputSchema,
  repoBacklogRunnerUpdateSchema,
  reorderBacklogInputSchema,
  updateBacklogItemInputSchema,
  type BacklogItem,
  type BacklogItemView,
  type Repo,
  type RepoBacklogRunner,
  type RepoIssues,
  type RepoJiraIssues,
  type ServerEvent,
  type Task,
  type TaskOrigin,
} from "@blackwall/shared";
import { Hono, type Context } from "hono";
import {
  postStartComment,
  queueTask,
  titleFor,
  type NewTaskServices,
  type TaskPipeline,
} from "./tasks.js";
import { badRequest, readJson } from "./validation.js";

export interface BacklogRouteStores {
  backlogItems: Repositories["backlogItems"];
  repos: Pick<Repositories["repos"], "get">;
  /** Linked tasks, to tell whether a dependency is done or a stacked PR is already worked on. */
  tasks: Pick<Repositories["tasks"], "get" | "list">;
}

/** The global backlog runner setting, and a repo's backlog runner switch, autonomy and halt. */
export type BacklogRunnerSettings = Pick<
  SettingsService,
  | "general"
  | "repoBacklogRunner"
  | "setRepoBacklogRunnerEnabled"
  | "setRepoBacklogAutonomous"
  | "setRepoBacklogIncludeRemoteIssues"
  | "setRepoBacklogHalt"
>;

/** The backlog routes' stores, plus the backlog runner's hooks. */
export interface BacklogRouteOptions extends BacklogRouteStores {
  /** The runner's per-repo state; omit to leave the runner routes out. */
  runner?: BacklogRunnerSettings;
  /** Told about every backlog change besides the clients (the backlog runner). */
  onChanged?: (repoId: string) => void;
}

export interface BacklogRouteServices {
  /** Sends an event to every connected client. */
  broadcast: (event: ServerEvent) => void;
  /**
   * Promotion ("run now"; omit to leave the run route out), and the autonomous
   * sweep when a repo's autonomy is switched on.
   */
  pipeline?: Pick<TaskPipeline, "createTask" | "autopilotRepo">;
  newTask?: NewTaskServices;
  runner?: BacklogRunnerSettings;
}

export interface BacklogPromotion {
  pipeline: Pick<TaskPipeline, "createTask">;
  newTask: NewTaskServices;
  backlogItems: Pick<Repositories["backlogItems"], "get" | "markPromoted">;
  broadcast: (event: ServerEvent) => void;
}

/**
 * Promotes a backlog item: creates a normal queued task from it through the
 * same path as the new task form, links it and announces the change. Used by
 * "Run now", the backlog runner and new tasks that start at once.
 *
 * Synchronous on purpose: no `await` may come before `markPromoted`, so no
 * other promotion can run between the status check and the link, and an item
 * never becomes two tasks.
 */
export function promoteBacklogItem(
  item: BacklogItem,
  { pipeline, newTask, backlogItems, broadcast }: BacklogPromotion,
): Task {
  const current = backlogItems.get(item.id);
  if (!current || current.status === "promoted") {
    throw new Error("The item was already promoted to a task");
  }
  const {
    title,
    origin,
    mode,
    repoId,
    freeText,
    agents,
    agentClis,
    referenceRepoIds,
    triageMode,
    inRepo,
  } = current;
  const task = queueTask(pipeline, newTask, {
    title,
    origin,
    mode,
    repoId,
    freeText,
    agents,
    agentClis,
    referenceRepoIds,
    triageMode,
    inRepo,
  });
  backlogItems.markPromoted(item.id, task.id);
  broadcast({ type: "backlog.changed", payload: { repoId } });
  return task;
}

/** The origin without its stack; only the server links a PR to its stack. */
export function withoutStack(origin: TaskOrigin): TaskOrigin {
  if (origin.kind !== "github-pr" || origin.stack === undefined) return origin;
  const rest = { ...origin };
  delete rest.stack;
  return rest;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

interface GitHubItemRef {
  owner: string;
  repo: string;
  number: number;
  /** Any link on the item's host. */
  url: string;
}

/** A PR or issue origin of the same host, owner, repo (case-insensitive) and number. */
function sameGitHubItem(
  origin: TaskOrigin,
  kind: "github-pr" | "github-issue",
  ref: GitHubItemRef,
): boolean {
  return (
    origin.kind === kind &&
    origin.number === ref.number &&
    origin.owner.toLowerCase() === ref.owner.toLowerCase() &&
    origin.repo.toLowerCase() === ref.repo.toLowerCase() &&
    hostOf(origin.url) === hostOf(ref.url)
  );
}

/**
 * Adds a waiting Review PR item for each other PR of `main`'s stack, bottom
 * first, with `main`'s agents and triage mode. PRs an unarchived
 * task or an unpromoted backlog item already works on are skipped; a promoted
 * item counts through its task. Returns the items added; the caller announces them.
 */
export function addStackSiblings(
  backlogItems: Pick<Repositories["backlogItems"], "list" | "insertMany">,
  tasks: Pick<Repositories["tasks"], "list">,
  {
    repoId,
    main,
    members,
  }: { repoId: string; main: BacklogItem; members: readonly PullRequestStackMember[] },
): BacklogItem[] {
  const { origin } = main;
  if (origin.kind !== "github-pr" || !origin.stack) return [];
  const live = tasks.list().filter((t) => t.archivedAt === null);
  const waiting = backlogItems.list().filter((i) => i.status !== "promoted");
  const tracked = (number: number) =>
    number === origin.number ||
    live.some((t) => sameGitHubItem(t.origin, "github-pr", { ...origin, number })) ||
    waiting.some((i) => sameGitHubItem(i.origin, "github-pr", { ...origin, number }));
  const siblings = members.filter((m) => !tracked(m.number));
  if (siblings.length === 0) return [];
  return backlogItems.insertMany(
    siblings.map((m) => ({
      repoId,
      title:
        m.title.trim().slice(0, MAX_TITLE_CHARS) || `${origin.owner}/${origin.repo}#${m.number}`,
      origin: { ...origin, number: m.number, url: m.url },
      mode: "review" as const,
      freeText: "",
      agents: main.agents,
      agentClis: main.agentClis,
      referenceRepoIds: main.referenceRepoIds,
      triageMode: main.triageMode,
      dependsOn: [],
    })),
  );
}

export interface RemoteIssueServices {
  /** The repo's open GitHub issues, newest first; host failures in `errors`. */
  listIssues: (repo: Repo) => Promise<RepoIssues>;
  /** The login of a connection's token user; throws on failure. */
  viewerLogin: (connectionId: string) => Promise<string>;
  /**
   * The repo's open Jira issues, unassigned or assigned to the user, newest
   * first; site failures in `errors`.
   */
  listJiraIssues: (repo: Repo) => Promise<RepoJiraIssues>;
  broadcast: (event: ServerEvent) => void;
}

function listingError(errors: readonly { host: string; message: string }[]): Error {
  return new Error(errors.map((e) => `${e.host}: ${e.message}`).join("; "));
}

/**
 * For the backlog runner: adds the repo's next open GitHub issue, or when none
 * qualifies the next open issue of its Jira project, as a waiting backlog item
 * at the end of its queue, and returns it. Takes the first issue in list order
 * (most recently updated first) that no task of the repo (archived or not) and
 * no item of the repo (whatever its status) covers; a Jira issue is covered
 * by its key. A GitHub issue must be unassigned or assigned to the token's
 * user; a Jira issue's query already asks for that. Never assigns, transitions
 * or comments on the issue. Undefined when no issue qualifies; throws when
 * either listing or the user lookup failed, Jira being asked only once GitHub
 * succeeded.
 */
export async function importRemoteIssue(
  {
    backlogItems,
    tasks,
  }: {
    backlogItems: Pick<Repositories["backlogItems"], "list" | "insert">;
    tasks: Pick<Repositories["tasks"], "list">;
  },
  { listIssues, viewerLogin, listJiraIssues, broadcast }: RemoteIssueServices,
  repo: Repo,
): Promise<BacklogItem | undefined> {
  const { issues, errors } = await listIssues(repo);
  if (errors.length > 0) throw listingError(errors);
  const origins = [
    ...tasks
      .list()
      .filter((t) => t.repoId === repo.id)
      .map((t) => t.origin),
    ...backlogItems.list(repo.id).map((i) => i.origin),
  ];
  // Never started at once, so no start comment: the runner promotes it.
  const addImported = (issueOrigin: TaskOrigin, title: string): BacklogItem => {
    const { origin, mode, freeText, agents, agentClis, referenceRepoIds, triageMode, dependsOn } =
      newBacklogItemInputSchema.parse({ origin: issueOrigin, title });
    const item = backlogItems.insert({
      repoId: repo.id,
      title,
      origin,
      mode,
      freeText,
      agents,
      agentClis,
      referenceRepoIds,
      triageMode,
      dependsOn,
    });
    broadcast({ type: "backlog.changed", payload: { repoId: repo.id } });
    return item;
  };
  const logins = new Map<string, string>();
  for (const issue of issues) {
    if (origins.some((origin) => sameGitHubItem(origin, "github-issue", issue))) continue;
    if (issue.assignees.length > 0) {
      if (!issue.connectionId) continue;
      let login = logins.get(issue.connectionId);
      if (login === undefined) {
        login = await viewerLogin(issue.connectionId);
        logins.set(issue.connectionId, login);
      }
      const viewer = login.toLowerCase();
      if (!issue.assignees.some((a) => a.toLowerCase() === viewer)) continue;
    }
    const title =
      issue.title.trim().slice(0, MAX_TITLE_CHARS) ||
      `${issue.owner}/${issue.repo}#${issue.number}`;
    return addImported(
      {
        kind: "github-issue",
        url: issue.url,
        owner: issue.owner,
        repo: issue.repo,
        number: issue.number,
        connectionId: issue.connectionId,
      },
      title,
    );
  }
  const jira = await listJiraIssues(repo);
  if (jira.errors.length > 0) throw listingError(jira.errors);
  for (const issue of jira.issues) {
    // Keys are uppercase, so the same issue has the same key on any connection.
    if (origins.some((origin) => origin.kind === "jira-issue" && origin.key === issue.key)) {
      continue;
    }
    const title = issue.title.trim().slice(0, MAX_TITLE_CHARS) || issue.key;
    return addImported(
      { kind: "jira-issue", key: issue.key, connectionId: issue.connectionId },
      title,
    );
  }
  return undefined;
}

/** A new backlog item the repo cannot take; the message is safe to show. */
export class BacklogInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacklogInputError";
  }
}

/** Dependency ids that are not items of the repo; an item cannot be its own. */
function foreignDependencies(items: BacklogItem[], dependsOn: string[]): string[] {
  const ids = new Set(items.map((i) => i.id));
  return dependsOn.filter((id) => !ids.has(id));
}

/**
 * Whether a new item starts at once: backlogs run automatically, the repo's
 * runner is on and the item's dependencies are done. A halt does not count;
 * it only stops the runner from picking other waiting items.
 */
function shouldStart(
  { backlogItems, tasks }: Pick<BacklogRouteStores, "backlogItems" | "tasks">,
  { pipeline, newTask, runner }: Pick<BacklogRouteServices, "pipeline" | "newTask" | "runner">,
  repoId: string,
  dependsOn: string[],
): boolean {
  if (!runner || !pipeline || !newTask) return false;
  const isDone = (taskId: string) => tasks.get(taskId)?.status === "done";
  const byId = new Map(backlogItems.list(repoId).map((i) => [i.id, i]));
  return (
    runner.general().backlogRunner &&
    runner.repoBacklogRunner(repoId).enabled &&
    // Only the dependencies are read, so the item need not exist yet.
    unmetDependencies({ dependsOn } as BacklogItem, byId, isDone).length === 0
  );
}

/**
 * The open PRs of a PR origin's stack, bottom first; undefined when it is
 * not stacked or the lookup fails. A missing token still throws.
 */
async function stackOf(
  newTask: NewTaskServices | undefined,
  origin: TaskOrigin,
): Promise<PullRequestStackMember[] | undefined> {
  if (origin.kind !== "github-pr" || !newTask?.pullRequestStack) return undefined;
  try {
    const members = await newTask.pullRequestStack(origin);
    return members && members.length >= 2 ? members : undefined;
  } catch (error) {
    // A missing token opens the token modal; other failures leave the PR unstacked.
    if (error instanceof MissingCredentialError) throw error;
    return undefined;
  }
}

/** A parsed `POST /api/repos/:repoId/backlog` body. */
export type NewBacklogItemParsed = ReturnType<typeof newBacklogItemInputSchema.parse>;

/**
 * Adds an item to a repo's backlog, for `POST /api/repos/:repoId/backlog` and
 * voice commands. With `start` it is promoted at once when the runner would
 * start it; a failed promotion removes it again. A PR that belongs to a stack
 * is linked to it and its other open PRs get waiting Review PR items (see
 * {@link addStackSiblings}). Throws {@link BacklogInputError} for
 * dependencies that are not the repo's items.
 */
export async function addBacklogItem(
  { backlogItems, repos, tasks }: BacklogRouteStores,
  services: BacklogRouteServices,
  repoId: string,
  input: NewBacklogItemParsed,
): Promise<BacklogItem> {
  const { broadcast, pipeline, newTask } = services;
  const changed = () => broadcast({ type: "backlog.changed", payload: { repoId } });
  const foreign = foreignDependencies(backlogItems.list(repoId), input.dependsOn);
  if (foreign.length > 0) {
    throw new BacklogInputError(`Unknown dependencies in this repo: ${foreign.join(", ")}`);
  }
  if (input.referenceRepoIds) {
    checkReferenceRepoIds(repos, repoId, input.referenceRepoIds);
  }
  const { start, startComment, ...parsed } = input;
  // Only the server links a PR to its stack.
  const values = { ...parsed, origin: withoutStack(parsed.origin) };
  // Everything that can fail runs before the insert, so retries add no duplicates.
  if (newTask && (start || values.title === undefined)) newTask.repos.use(repoId);
  const title =
    values.title ?? (await titleFor(values.origin, values.freeText, newTask?.originTitle));
  const stack = await stackOf(newTask, values.origin);
  if (stack && values.origin.kind === "github-pr") {
    values.origin = { ...values.origin, stack: { prs: stack.map((m) => m.number) } };
  }
  const startsNow =
    start && shouldStart({ backlogItems, tasks }, services, repoId, values.dependsOn);
  // The confirmed start comment goes out only with a task that starts now,
  // never later when the runner promotes the item on its own.
  if (startComment && startsNow && newTask) {
    await postStartComment(newTask, values.origin, startComment);
  }
  let item = backlogItems.insert({ ...values, title, repoId });
  if (startsNow && pipeline && newTask) {
    try {
      // Announces the change itself.
      promoteBacklogItem(item, { pipeline, newTask, backlogItems, broadcast });
      item = backlogItems.get(item.id) ?? item;
    } catch (error) {
      // Never announced, so clients never saw it.
      backlogItems.delete(item.id);
      throw error;
    }
  } else {
    changed();
  }
  if (stack) {
    try {
      const added = addStackSiblings(backlogItems, tasks, { repoId, main: item, members: stack });
      // The backlog runner picks them up when the repo's runner is on.
      if (added.length > 0) changed();
    } catch (error) {
      console.error(`Could not add the other pull requests of the stack: ${String(error)}`);
    }
  }
  return item;
}

/**
 * A repo's backlog, mounted at `/api/repos/:repoId/backlog`. Items wait until
 * promoted; `run` promotes one now through the same path as the new task
 * form, and a new item sent with `start` is promoted at once when the runner
 * would start it. A new PR item that belongs to a stack is linked to it
 * (`origin.stack`), and the stack's other open PRs get waiting Review PR
 * items (see {@link addStackSiblings}). Every change is announced as
 * `backlog.changed` so clients refetch.
 */
export function backlogRoutes(
  { backlogItems, repos, tasks }: BacklogRouteStores,
  services: BacklogRouteServices,
): Hono {
  const { broadcast, pipeline, newTask, runner } = services;
  const routes = new Hono();

  const isDone = (taskId: string) => tasks.get(taskId)?.status === "done";
  const changed = (repoId: string) => broadcast({ type: "backlog.changed", payload: { repoId } });

  routes.use("*", async (c, next) => {
    const repoId = c.req.param("repoId") ?? "";
    if (!repos.get(repoId)) return c.json({ error: `Repo ${repoId} not found` }, 404);
    await next();
  });

  if (runner) {
    /** Whether the runner promotes this repo's items, and the failed task that halted it. */
    routes.get("/runner", (c) =>
      c.json<RepoBacklogRunner>(runner.repoBacklogRunner(c.req.param("repoId") ?? "")),
    );

    routes.patch("/runner", async (c) => {
      const repoId = c.req.param("repoId") ?? "";
      const input = repoBacklogRunnerUpdateSchema.safeParse(await readJson(c));
      if (!input.success) return badRequest(c, input.error.issues);
      const { enabled, autonomous, includeRemoteIssues } = input.data;
      const wasAutonomous = runner.repoBacklogRunner(repoId).autonomous;
      if (enabled !== undefined) runner.setRepoBacklogRunnerEnabled(repoId, enabled);
      if (autonomous !== undefined) runner.setRepoBacklogAutonomous(repoId, autonomous);
      if (includeRemoteIssues !== undefined) {
        runner.setRepoBacklogIncludeRemoteIssues(repoId, includeRemoteIssues);
      }
      // Tasks already waiting at a gate move on without the user; a finish may
      // take a while to deliver, so the response does not wait for it.
      if (autonomous && !wasAutonomous) void pipeline?.autopilotRepo(repoId);
      changed(repoId);
      return c.json<RepoBacklogRunner>(runner.repoBacklogRunner(repoId));
    });

    /** Clears a halt so the runner moves on with the backlog. */
    routes.post("/runner/resume", (c) => {
      const repoId = c.req.param("repoId") ?? "";
      const state = runner.setRepoBacklogHalt(repoId, null);
      changed(repoId);
      return c.json<RepoBacklogRunner>(state);
    });
  }

  /** The repo's items in pick order, each with the dependencies still holding it back. */
  routes.get("/", (c) => {
    const items = backlogItems.list(c.req.param("repoId"));
    const byId = new Map(items.map((i) => [i.id, i]));
    return c.json<BacklogItemView[]>(
      sortBacklog(items).map((item) => {
        const blockedBy = unmetDependencies(item, byId, isDone);
        return { ...item, blocked: blockedBy.length > 0, blockedBy };
      }),
    );
  });

  routes.post("/", async (c) => {
    const repoId = c.req.param("repoId") ?? "";
    const input = newBacklogItemInputSchema.safeParse(await readJson(c));
    if (!input.success) return badRequest(c, input.error.issues);
    try {
      const item = await addBacklogItem(
        { backlogItems, repos, tasks },
        services,
        repoId,
        input.data,
      );
      return c.json<BacklogItem>(item, 201);
    } catch (error) {
      if (error instanceof BacklogInputError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  /** Sets the manual order; the body lists every item of the repo once. */
  routes.post("/reorder", async (c) => {
    const repoId = c.req.param("repoId") ?? "";
    const input = reorderBacklogInputSchema.safeParse(await readJson(c));
    if (!input.success) return badRequest(c, input.error.issues);
    const items = backlogItems.list(repoId);
    const listed = new Set(input.data.ids);
    if (items.length !== listed.size || items.some((i) => !listed.has(i.id))) {
      return c.json({ error: "List every backlog item of the repo exactly once" }, 400);
    }
    backlogItems.reorder(repoId, input.data.ids);
    changed(repoId);
    return c.json<BacklogItem[]>(sortBacklog(backlogItems.list(repoId)));
  });

  /** The repo's item, or undefined (another repo's item counts as missing). */
  function itemOf(c: Context): BacklogItem | undefined {
    const item = backlogItems.get(c.req.param("id") ?? "");
    return item?.repoId === c.req.param("repoId") ? item : undefined;
  }
  const notFound = (c: Context) =>
    c.json({ error: `Backlog item ${c.req.param("id")} not found` }, 404);

  routes.patch("/:id", async (c) => {
    const item = itemOf(c);
    if (!item) return notFound(c);
    if (item.status === "promoted") {
      return c.json({ error: "The item was already promoted to a task" }, 409);
    }
    const input = updateBacklogItemInputSchema.safeParse(await readJson(c));
    if (!input.success) return badRequest(c, input.error.issues);
    const { dependsOn } = input.data;
    if (input.data.inRepo && item.origin.kind === "github-pr") {
      return c.json({ error: "PR tasks always use a worktree" }, 400);
    }
    if (dependsOn) {
      const items = backlogItems.list(item.repoId);
      const foreign = foreignDependencies(items, dependsOn);
      if (foreign.length > 0) {
        return c.json({ error: `Unknown dependencies in this repo: ${foreign.join(", ")}` }, 400);
      }
      if (createsDependencyCycle(items, item.id, dependsOn)) {
        return c.json({ error: "The dependencies would form a cycle" }, 400);
      }
    }
    if (input.data.referenceRepoIds) {
      checkReferenceRepoIds(repos, item.repoId, input.data.referenceRepoIds);
    }
    const updated = backlogItems.update(item.id, input.data);
    changed(item.repoId);
    return c.json<BacklogItem>(updated);
  });

  routes.delete("/:id", (c) => {
    const item = itemOf(c);
    if (!item) return notFound(c);
    backlogItems.delete(item.id);
    changed(item.repoId);
    return c.body(null, 204);
  });

  if (pipeline && newTask) {
    /** Promotes the item now: creates a normal queued task from it and links it. */
    routes.post("/:id/run", (c) => {
      const item = itemOf(c);
      if (!item) return notFound(c);
      if (item.status === "promoted") {
        return c.json({ error: "The item was already promoted to a task" }, 409);
      }
      const task = promoteBacklogItem(item, {
        pipeline,
        newTask,
        backlogItems,
        broadcast,
      });
      return c.json<Task>(task, 201);
    });
  }

  return routes;
}
