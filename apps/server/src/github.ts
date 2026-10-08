import type { ConnectionService, OriginContextProvider, RepoService } from "@blackwall/core";
import {
  createGitHubClient,
  findRepoForPullRequest,
  informFromPullRequest,
  parsePullRequestUrl,
  type Fetch,
  type GitHubCredentials,
  type JiraCredentials,
} from "@blackwall/integrations";
import {
  JIRA_EMAIL_META,
  pullRequestLookupInputSchema,
  type PullRequestLookup,
  type Task,
} from "@blackwall/shared";
import { Hono } from "hono";

type PrOrigin = Extract<Task["origin"], { kind: "github-pr" }>;

export interface GitHubOriginOptions {
  connections: Pick<ConnectionService, "list" | "credentialById" | "requireCredential">;
  fetch?: Fetch;
}

/**
 * PR tasks' origin hooks for the pipeline: the PR head branch for the
 * worktree, and the PR (description, diff, review comments, plus the linked
 * Jira issue when one is named and a single Jira site is set up) as Inform
 * context. Without a stored connection id the connection comes from the
 * PR link's host.
 */
export function createGitHubOrigin({ connections, fetch: fetchImpl }: GitHubOriginOptions) {
  async function credentials(origin: PrOrigin): Promise<GitHubCredentials> {
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

  return {
    /** The PR's head branch; PRs from forks have no branch on `origin` to check out. */
    async branchFor(task: Task): Promise<string | undefined> {
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

    originContext: (async (task, signal) => {
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

export interface PullRequestRoutesOptions {
  connections: Pick<ConnectionService, "resolve">;
  repos: Pick<RepoService, "list">;
}

/**
 * `POST /lookup`: resolves a pasted PR link to a task origin (with the
 * host's connection) and the registered repo. A null `repoId` tells the new
 * task form to offer registering the repo first.
 */
export function pullRequestRoutes({ connections, repos }: PullRequestRoutesOptions): Hono {
  const routes = new Hono();

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
