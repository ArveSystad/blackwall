import {
  MissingCredentialError,
  branchForTask,
  type ConnectionService,
  type OriginContextProvider,
} from "@blackwall/core";
import {
  createJiraClient,
  informFromJira,
  type Fetch,
  type JiraCredentials,
} from "@blackwall/integrations";
import { JIRA_EMAIL_META, type Task } from "@blackwall/shared";

type JiraOrigin = Extract<Task["origin"], { kind: "jira-issue" }>;

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
    const { connection, token } = await connections.credentialById(id);
    const email = connection.authMeta[JIRA_EMAIL_META];
    if (!email) throw new Error(`Jira connection ${connection.name} has no account email`);
    return { baseUrl: connection.baseUrl, email, token };
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
