import {
  branchForTask,
  connectionHost,
  type ConnectionService,
  type OpenPullRequestAction,
  type OriginContextProvider,
  type RepoService,
} from "@blackwall/core";
import {
  assertNotPullRequest,
  buildReviewPayload,
  createGitHubClient,
  findRepoForPullRequest,
  informFromIssue,
  informFromPullRequest,
  issueLabels,
  parseIssueUrl,
  parsePullRequestUrl,
  parseRemoteSlug,
  signComment,
  type Fetch,
  type GitHubClient,
  type GitHubCredentials,
  type JiraCredentials,
} from "@blackwall/integrations";
import {
  JIRA_EMAIL_META,
  issueLookupInputSchema,
  pullRequestLookupInputSchema,
  type AssignedIssues,
  type Finding,
  type IssueLookup,
  type PullRequestLookup,
  type RepoIssues,
  type ReviewRequests,
  type Task,
} from "@blackwall/shared";
import { Hono } from "hono";

type PrOrigin = Extract<Task["origin"], { kind: "github-pr" }>;
type IssueOrigin = Extract<Task["origin"], { kind: "github-issue" }>;

export interface GitHubOriginOptions {
  connections: Pick<ConnectionService, "list" | "credentialById" | "requireCredential">;
  fetch?: Fetch;
}

/**
 * PR and issue tasks' origin hooks for the pipeline: the PR head branch (or,
 * for an issue, a new `feature/<n>-<slug>` branch) for the worktree, the PR
 * (description, diff, review comments, plus the linked Jira issue when one is
 * named and a single Jira site is set up) or the issue as Inform context, and
 * the calls that post to GitHub/GHE. Without a stored connection id the
 * connection comes from the link's host.
 */
export function createGitHubOrigin({ connections, fetch: fetchImpl }: GitHubOriginOptions) {
  async function credentials(origin: PrOrigin | IssueOrigin): Promise<GitHubCredentials> {
    const { connection, token } = origin.connectionId
      ? await connections.credentialById(origin.connectionId)
      : await connections.requireCredential({ kind: "github", remote: origin.url });
    return { baseUrl: connection.baseUrl, token };
  }

  /** The only Jira site, for a key in the PR's branch or title; none when zero or several exist. */
  async function jiraCredentials(): Promise<JiraCredentials | undefined> {
    const jira = connections.list().filter((c) => c.kind === "jira" && c.hasToken);
    if (jira.length !== 1) return undefined;
    const { connection, token } = await connections.credentialById(jira[0]!.id);
    const email = connection.authMeta[JIRA_EMAIL_META];
    return email ? { baseUrl: connection.baseUrl, email, token } : undefined;
  }

  const prOrigin = (task: Task): PrOrigin | undefined =>
    task.origin.kind === "github-pr" ? task.origin : undefined;

  function requirePr(task: Task): PrOrigin {
    const origin = prOrigin(task);
    if (!origin) throw new Error(`Task ${task.id} has no pull request`);
    return origin;
  }

  const issueOrigin = (task: Task): IssueOrigin | undefined =>
    task.origin.kind === "github-issue" ? task.origin : undefined;

  async function prClient(origin: PrOrigin | IssueOrigin) {
    return createGitHubClient(await credentials(origin), fetchImpl);
  }

  /** The issue's metadata; refuses a link that is really a pull request. */
  async function getIssue(origin: IssueOrigin) {
    const issue = await (await prClient(origin)).getIssue(origin);
    assertNotPullRequest(issue, origin);
    return issue;
  }

  return {
    /**
     * The PR's head branch (PRs from forks have no branch on `origin` to check
     * out), or an issue's new branch: `fix/<n>-<slug>` with a `bug` label,
     * `feature/<n>-<slug>` otherwise.
     */
    async branchFor(task: Task): Promise<string | undefined> {
      const issue = issueOrigin(task);
      if (issue) {
        const json = await getIssue(issue);
        return branchForTask({
          kind: "github-issue",
          number: issue.number,
          title: json.title || task.title,
          bug: issueLabels(json).some((l) => l.trim().toLowerCase() === "bug"),
        });
      }
      const origin = prOrigin(task);
      if (!origin) return undefined;
      const client = createGitHubClient(await credentials(origin), fetchImpl);
      const pr = await client.getPullRequest(origin);
      const headRepo = pr.head.repo?.full_name;
      if (headRepo && headRepo.toLowerCase() !== `${origin.owner}/${origin.repo}`.toLowerCase()) {
        throw new Error(
          `Pull request ${origin.owner}/${origin.repo}#${origin.number} comes from the fork ${headRepo}, which is not supported`,
        );
      }
      return pr.head.ref;
    },

    /** The pull request's or issue's title, as a new task's title. */
    async titleFor(origin: Task["origin"]): Promise<string | undefined> {
      if (origin.kind === "github-issue") return (await getIssue(origin)).title;
      if (origin.kind !== "github-pr") return undefined;
      return (await (await prClient(origin)).getPullRequest(origin)).title;
    },

    originContext: (async (task, signal) => {
      const issue = issueOrigin(task);
      if (issue) {
        const result = await informFromIssue(await credentials(issue), issue, {
          signal,
          ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
        return result.markdown;
      }
      const origin = prOrigin(task);
      if (!origin) return undefined;
      const jira = await jiraCredentials();
      const result = await informFromPullRequest(await credentials(origin), origin, {
        signal,
        ...(jira ? { jira } : {}),
        ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
      return result.markdown;
    }) satisfies OriginContextProvider,

    /** Opens a pull request on the host of the repo's remote. */
    async openPullRequest(action: OpenPullRequestAction): Promise<{ url: string }> {
      const { connection, token } = await connections.requireCredential({
        kind: "github",
        remote: `https://${action.host}/${action.owner}/${action.repo}.git`,
      });
      const client = createGitHubClient({ baseUrl: connection.baseUrl, token }, fetchImpl);
      const { url } = await client.createPullRequest({
        owner: action.owner,
        repo: action.repo,
        head: action.head,
        base: action.base,
        title: action.title,
        body: action.body,
      });
      return { url };
    },

    /** Posts a conversation comment on the task's pull request, signed as blackwall's. */
    async commentOnPullRequest(task: Task, body: string): Promise<{ url: string }> {
      const origin = requirePr(task);
      const { url } = await (await prClient(origin)).addComment(origin, signComment(body));
      return { url };
    },

    /**
     * Posts a comment on a GitHub issue task's issue (given the task, or the
     * origin of one not created yet), signed as blackwall's.
     */
    async commentOnIssue(target: Task | IssueOrigin, body: string): Promise<{ url: string }> {
      const origin = "kind" in target ? target : issueOrigin(target);
      if (!origin) throw new Error("The task has no GitHub issue");
      const { url } = await (await prClient(origin)).addComment(origin, signComment(body));
      return { url };
    },

    /** Assigns a GitHub issue to the token's user; already assigned is fine. */
    async assignIssue(origin: IssueOrigin): Promise<{ login: string }> {
      return (await prClient(origin)).assignToViewer(origin);
    },

    /**
     * Submits a `COMMENT` review on the task's pull request: findings on a
     * line of the PR's diff become inline comments, the rest go in the body,
     * which is signed as blackwall's.
     */
    async reviewPullRequest(task: Task, findings: readonly Finding[]): Promise<{ url: string }> {
      const origin = requirePr(task);
      const client = await prClient(origin);
      const [pr, diff] = await Promise.all([
        client.getPullRequest(origin),
        client.getPullRequestDiff(origin),
      ]);
      const payload = buildReviewPayload(findings, { diff, commitId: pr.head.sha });
      const { url } = await client.createReview(origin, {
        ...payload,
        body: signComment(payload.body),
      });
      return { url };
    },
  };
}

type BranchFor = (task: Task) => Promise<string | undefined>;

/** Asks each origin's hook in turn; the first that knows the task answers. */
export function firstBranchFor(...hooks: BranchFor[]): BranchFor {
  return async (task) => {
    for (const hook of hooks) {
      const branch = await hook(task);
      if (branch !== undefined) return branch;
    }
    return undefined;
  };
}

/** Asks each origin's context provider in turn; the first that knows the task answers. */
export function firstOriginContext(...providers: OriginContextProvider[]): OriginContextProvider {
  return async (task, signal) => {
    for (const provider of providers) {
      const context = await provider(task, signal);
      if (context !== undefined) return context;
    }
    return undefined;
  };
}

/**
 * Runs `search` on every GitHub/GHE connection with a token in parallel and
 * merges the rows, newest first. A host that fails is listed in `errors`; the
 * other hosts' rows still come back.
 */
async function searchEveryGitHubHost<T extends { updatedAt: string }>(
  connections: Pick<ConnectionService, "list" | "credentialById">,
  fetchImpl: Fetch | undefined,
  search: (client: GitHubClient) => Promise<T[]>,
): Promise<{
  rows: (Omit<T, "updatedAt"> & { updatedAt: Date })[];
  errors: { host: string; message: string }[];
}> {
  const github = connections.list().filter((conn) => conn.kind === "github" && conn.hasToken);
  const results = await Promise.allSettled(
    github.map(async (conn) => {
      const { connection, token } = await connections.credentialById(conn.id);
      return search(createGitHubClient({ baseUrl: connection.baseUrl, token }, fetchImpl));
    }),
  );
  const rows: (Omit<T, "updatedAt"> & { updatedAt: Date })[] = [];
  const errors: { host: string; message: string }[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      rows.push(...result.value.map((row) => ({ ...row, updatedAt: new Date(row.updatedAt) })));
    } else {
      const message =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push({ host: connectionHost(github[i]!), message });
    }
  });
  rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return { rows, errors };
}

export interface PullRequestRoutesOptions {
  connections: Pick<ConnectionService, "resolve" | "list" | "credentialById">;
  repos: Pick<RepoService, "list">;
  fetch?: Fetch;
}

/**
 * `POST /lookup`: resolves a pasted PR link to a task origin (with the
 * host's connection) and the registered repo. A null `repoId` tells the new
 * task form to offer registering the repo first.
 *
 * `GET /review-requests`: the open PRs waiting on the user's review on every
 * GitHub/GHE connection with a token, newest first. A host that fails is
 * listed in `errors`; the other hosts' PRs still come back. Each PR carries its
 * registered repo (`repoId`, null when no repo's `origin` is the PR's
 * repository) and its host's connection (`connectionId`), resolved as `/lookup` does.
 */
export function pullRequestRoutes({
  connections,
  repos,
  fetch: fetchImpl,
}: PullRequestRoutesOptions): Hono {
  const routes = new Hono();

  routes.get("/review-requests", async (c) => {
    const { rows, errors } = await searchEveryGitHubHost(connections, fetchImpl, (client) =>
      client.searchReviewRequests(),
    );
    const registered = repos.list();
    const pullRequests = rows.map((pr) => {
      const ref = parsePullRequestUrl(pr.url);
      const repo = ref && findRepoForPullRequest(registered, ref);
      const connection = connections.resolve({ kind: "github", remote: pr.url });
      return { ...pr, repoId: repo?.id ?? null, connectionId: connection?.id ?? null };
    });
    return c.json<ReviewRequests>({ pullRequests, errors });
  });

  routes.post("/lookup", async (c) => {
    const input = pullRequestLookupInputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success) {
      return c.json({ error: input.error.issues.map((i) => i.message).join("; ") }, 400);
    }
    const ref = parsePullRequestUrl(input.data.url);
    if (!ref)
      return c.json(
        { error: "Expected a pull request link like https://github.com/owner/repo/pull/1" },
        400,
      );
    const connection = connections.resolve({ kind: "github", remote: ref.url });
    const repo = findRepoForPullRequest(repos.list(), ref);
    return c.json<PullRequestLookup>({
      origin: {
        kind: "github-pr",
        url: ref.url,
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        connectionId: connection?.id ?? null,
      },
      repoId: repo?.id ?? null,
    });
  });

  return routes;
}

export interface IssueRoutesOptions {
  connections: Pick<ConnectionService, "resolve" | "list" | "credentialById">;
  repos: Pick<RepoService, "list">;
  fetch?: Fetch;
}

/**
 * `POST /lookup`: resolves a pasted GitHub issue link to a task origin (with
 * the host's connection) and the registered repo of the issue's repository.
 * A null `repoId` leaves the repo to the user, since an issue can be worked
 * on in another repo.
 *
 * `GET /assigned`: the open issues assigned to the user on every GitHub/GHE
 * connection with a token, newest first. A host that fails is listed in
 * `errors`; the other hosts' issues still come back. Each issue carries its
 * registered repo (`repoId`, null when no repo's `origin` is the issue's
 * repository) and its host's connection (`connectionId`), resolved as `/lookup` does.
 *
 * `GET /repo/:repoId`: the open issues of the repo's `origin` repository,
 * whoever they are assigned to, at most the 100 most recently updated, newest
 * first. Empty when the repo has no GitHub remote or its connection has no
 * token, so polling never asks for one; a host failure is listed in `errors`.
 */
export function issueRoutes({ connections, repos, fetch: fetchImpl }: IssueRoutesOptions): Hono {
  const routes = new Hono();

  routes.get("/assigned", async (c) => {
    const { rows, errors } = await searchEveryGitHubHost(connections, fetchImpl, (client) =>
      client.searchAssignedIssues(),
    );
    const registered = repos.list();
    const issues = rows.map((issue) => {
      const ref = parseIssueUrl(issue.url);
      const repo = ref && findRepoForPullRequest(registered, ref);
      const connection = connections.resolve({ kind: "github", remote: issue.url });
      return { ...issue, repoId: repo?.id ?? null, connectionId: connection?.id ?? null };
    });
    return c.json<AssignedIssues>({ issues, errors });
  });

  routes.get("/repo/:repoId", async (c) => {
    const repoId = c.req.param("repoId");
    const repo = repos.list().find((r) => r.id === repoId);
    if (!repo) return c.json({ error: `Repo ${repoId} not found` }, 404);
    const none: RepoIssues = { issues: [], errors: [] };
    const slug = repo.remoteUrl ? parseRemoteSlug(repo.remoteUrl) : undefined;
    if (!repo.remoteUrl || !slug) return c.json(none);
    const connection = connections.resolve({ kind: "github", remote: repo.remoteUrl });
    const view = connection && connections.list().find((conn) => conn.id === connection.id);
    if (!connection || !view?.hasToken) return c.json(none);
    try {
      const { token } = await connections.credentialById(connection.id);
      const client = createGitHubClient({ baseUrl: connection.baseUrl, token }, fetchImpl);
      const rows = await client.searchRepoIssues({ owner: slug.owner, repo: slug.repo });
      const issues = rows
        .map((issue) => ({
          ...issue,
          updatedAt: new Date(issue.updatedAt),
          repoId: repo.id,
          connectionId: connection.id,
        }))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return c.json<RepoIssues>({ issues, errors: [] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json<RepoIssues>({
        issues: [],
        errors: [{ host: connectionHost(connection), message }],
      });
    }
  });

  routes.post("/lookup", async (c) => {
    const input = issueLookupInputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success) {
      return c.json({ error: input.error.issues.map((i) => i.message).join("; ") }, 400);
    }
    const ref = parseIssueUrl(input.data.url);
    if (!ref)
      return c.json(
        { error: "Expected an issue link like https://github.com/owner/repo/issues/1" },
        400,
      );
    const connection = connections.resolve({ kind: "github", remote: ref.url });
    const repo = findRepoForPullRequest(repos.list(), ref);
    return c.json<IssueLookup>({
      origin: {
        kind: "github-issue",
        url: ref.url,
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        connectionId: connection?.id ?? null,
      },
      repoId: repo?.id ?? null,
    });
  });

  return routes;
}
