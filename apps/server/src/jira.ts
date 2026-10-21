import {
  MissingCredentialError,
  branchForTask,
  connectionHost,
  type ConnectionService,
  type OriginContextProvider,
  type RepoService,
} from "@blackwall/core";
import {
  createJiraClient,
  informFromJira,
  type Fetch,
  type JiraCredentials,
} from "@blackwall/integrations";
import {
  JIRA_EMAIL_META,
  type Repo,
  type RepoJiraIssue,
  type RepoJiraIssues,
  type Task,
} from "@blackwall/shared";
import { Hono } from "hono";

type JiraOrigin = Extract<Task["origin"], { kind: "jira-issue" }>;

/** The site and account of a Jira connection; throws when it has no account email. */
async function jiraCredentialsFor(
  connections: Pick<ConnectionService, "credentialById">,
  id: string,
): Promise<JiraCredentials> {
  const { connection, token } = await connections.credentialById(id);
  const email = connection.authMeta[JIRA_EMAIL_META];
  if (!email) throw new Error(`Jira connection ${connection.name} has no account email`);
  return { baseUrl: connection.baseUrl, email, token };
}

export interface JiraOriginOptions {
  connections: Pick<ConnectionService, "list" | "credentialById">;
  fetch?: Fetch;
}

/**
 * Jira tasks' origin hooks for the pipeline: the branch derived from the
 * issue, the issue (with its attachments downloaded into the worktree) as
 * Inform context, and the summary comment at delivery. A task without a
 * connection uses the only Jira connection there is.
 */
export function createJiraOrigin({ connections, fetch: fetchImpl }: JiraOriginOptions) {
  async function credentials(origin: JiraOrigin): Promise<JiraCredentials> {
    let id = origin.connectionId;
    if (!id) {
      const jira = connections.list().filter((c) => c.kind === "jira");
      if (jira.length === 0) throw new MissingCredentialError("jira", "Jira Cloud", null);
      if (jira.length > 1) {
        throw new Error(`Jira task ${origin.key} has no connection and several Jira sites exist`);
      }
      id = jira[0]!.id;
    }
    return jiraCredentialsFor(connections, id);
  }

  const jiraOrigin = (task: Task): JiraOrigin | undefined =>
    task.origin.kind === "jira-issue" ? task.origin : undefined;

  return {
    /** `feature/<key>-<slug>`, or `fix/…` for a Bug, from the issue's summary and type. */
    async branchFor(task: Task): Promise<string | undefined> {
      const origin = jiraOrigin(task);
      if (!origin) return undefined;
      const client = createJiraClient(await credentials(origin), fetchImpl);
      const issue = await client.getIssueSummary(origin.key);
      return branchForTask({
        kind: "jira-issue",
        key: issue.key,
        title: issue.fields?.summary ?? task.title,
        issueType: issue.fields?.issuetype?.name ?? "",
      });
    },

    /** The issue's summary, as a new task's title. */
    async titleFor(origin: Task["origin"]): Promise<string | undefined> {
      if (origin.kind !== "jira-issue") return undefined;
      const client = createJiraClient(await credentials(origin), fetchImpl);
      return (await client.getIssueSummary(origin.key)).fields?.summary ?? undefined;
    },

    originContext: (async (task, signal) => {
      const origin = jiraOrigin(task);
      if (!origin) return undefined;
      const result = await informFromJira(await credentials(origin), origin.key, {
        signal,
        ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
      return result.markdown;
    }) satisfies OriginContextProvider,

    /** The issue's web link, when its Jira site is known without asking the keychain. */
    issueUrl(task: Task): string | undefined {
      const origin = jiraOrigin(task);
      if (!origin) return undefined;
      const jira = connections.list().filter((c) => c.kind === "jira");
      const site = origin.connectionId
        ? jira.find((c) => c.id === origin.connectionId)
        : jira.length === 1
          ? jira[0]
          : undefined;
      return site ? `${site.baseUrl.replace(/\/+$/, "")}/browse/${origin.key}` : undefined;
    },

    /** Posts the summary as a comment on the issue (markdown becomes ADF). Never transitions it. */
    async commentOnIssue(task: Task, body: string): Promise<{ url: string | null }> {
      const origin = jiraOrigin(task);
      if (!origin) throw new Error(`Task ${task.id} has no Jira issue`);
      const creds = await credentials(origin);
      const { id } = await createJiraClient(creds, fetchImpl).addComment(origin.key, body);
      const issue = `${creds.baseUrl.replace(/\/+$/, "")}/browse/${origin.key}`;
      return { url: id ? `${issue}?focusedCommentId=${id}` : issue };
    },
  };
}

export interface JiraIssueSourceOptions {
  connections: Pick<ConnectionService, "list" | "credentialById">;
  fetch?: Fetch;
}

export type JiraIssueSource = ReturnType<typeof createJiraIssueSource>;

/** Issues the Backlog lists: open, and unassigned or assigned to the token's account. */
function backlogJql(project: string): string {
  return (
    `project = "${project}" AND statusCategory != Done ` +
    `AND (assignee is EMPTY OR assignee = currentUser()) ORDER BY updated DESC`
  );
}

/**
 * Reads a repo's open Jira issues for the Backlog, never asking for a token:
 * only Jira connections with a token count.
 */
export function createJiraIssueSource({ connections, fetch: fetchImpl }: JiraIssueSourceOptions) {
  return {
    /**
     * The open issues of the repo's Jira project, unassigned or assigned to
     * the user, at most the 100 most recently updated, newest first. Empty
     * when the repo has no project or no Jira connection has a token; several
     * such connections, or a site failure, are listed in `errors`, never thrown.
     */
    async listRepoJiraIssues(repo: Repo): Promise<RepoJiraIssues> {
      const none: RepoJiraIssues = { issues: [], errors: [] };
      if (!repo.jiraProject) return none;
      const jira = connections.list().filter((c) => c.kind === "jira" && c.hasToken);
      if (jira.length === 0) return none;
      if (jira.length > 1) {
        const host = jira.map(connectionHost).join(", ");
        const message = "Several Jira sites exist; keep a token on only one to list issues";
        return { issues: [], errors: [{ host, message }] };
      }
      const connection = jira[0]!;
      const host = connectionHost(connection);
      try {
        const client = createJiraClient(
          await jiraCredentialsFor(connections, connection.id),
          fetchImpl,
        );
        const rows = await client.searchIssues(backlogJql(repo.jiraProject));
        const issues = rows
          .map((issue): RepoJiraIssue => ({
            host,
            key: issue.key,
            title: issue.fields.summary ?? "",
            url: `${client.baseUrl}/browse/${issue.key}`,
            issueType: issue.fields.issuetype?.name ?? null,
            status: issue.fields.status?.name ?? null,
            author: issue.fields.reporter?.displayName ?? null,
            assignee: issue.fields.assignee?.displayName ?? null,
            updatedAt: new Date(issue.fields.updated ?? 0),
            repoId: repo.id,
            connectionId: connection.id,
          }))
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        return { issues, errors: [] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { issues: [], errors: [{ host, message }] };
      }
    },
  };
}

export interface JiraIssueRoutesOptions {
  connections: Pick<ConnectionService, "list" | "credentialById">;
  repos: Pick<RepoService, "list">;
  fetch?: Fetch;
  /** Built from `connections` and `fetch` when omitted. */
  source?: Pick<JiraIssueSource, "listRepoJiraIssues">;
}

/**
 * `GET /:repoId`: the open issues of the repo's Jira project, unassigned or
 * assigned to the user, at most the 100 most recently updated, newest first.
 * Empty when the repo has no project or no Jira connection has a token, so
 * polling never asks for one; several Jira sites with a token, or a site
 * failure, are listed in `errors`.
 */
export function jiraIssueRoutes({
  connections,
  repos,
  fetch: fetchImpl,
  source = createJiraIssueSource({ connections, ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
}: JiraIssueRoutesOptions): Hono {
  const routes = new Hono();

  routes.get("/:repoId", async (c) => {
    const repoId = c.req.param("repoId");
    const repo = repos.list().find((r) => r.id === repoId);
    if (!repo) return c.json({ error: `Repo ${repoId} not found` }, 404);
    return c.json<RepoJiraIssues>(await source.listRepoJiraIssues(repo));
  });

  return routes;
}
