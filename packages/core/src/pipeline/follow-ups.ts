import {
  MAX_FOLLOW_UPS,
  originRef,
  type BacklogItem,
  type DeliveryAction,
  type FollowUp,
  type Repo,
  type Task,
} from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";

/** A follow-up as offered at finish: its target repo resolved to a registered one. */
export type ResolvedFollowUp = Extract<DeliveryAction, { kind: "create-tasks" }>["items"][number];

/** Where a follow-up can be created as a GitHub issue. */
export type FollowUpIssueTarget = NonNullable<ResolvedFollowUp["issueTarget"]>;

/**
 * The prompt section on follow-up tasks: the registered repos by id (names
 * are not unique), which one is the task's own, and the rules that keep
 * follow-ups independent so they can all run at once.
 */
export function followUpsPromptSection(repos: readonly Pick<Repo, "id" | "name">[], task: Task) {
  const list = repos.map(
    (repo) =>
      `- \`${repo.id}\`: ${repo.name}${repo.id === task.repoId ? " (this task's repo)" : ""}`,
  );
  return [
    "## Follow-up tasks",
    "",
    "Work that belongs outside this task can become follow-up tasks. At finish the user confirms them and chooses, for each one, whether it becomes a backlog item in its repo or a GitHub issue (an issue only when that repo has a GitHub or GitHub Enterprise origin with a connection). Each names its target repo by id, or null for this task's repo. The registered repos:",
    "",
    ...list,
    "",
    "- A request to create issues, create tasks or break the work down is delivered as follow-ups: the plan lists them under a `### Follow-up tasks` heading, and the summary returns each one as a `followUps` entry, never only described in prose.",
    "- Each follow-up must be independent: it can start, be implemented and be merged on its own, in any order, alongside the others.",
    "- Do not split a sequence into separate follow-ups. Propose one follow-up for the first step; its description states the later steps and tells that task to propose them as its own follow-ups once it is done.",
    `- Prefer fewer, self-contained follow-ups over many small coupled ones; at most ${MAX_FOLLOW_UPS}.`,
  ].join("\n");
}

/**
 * The follow-ups with their target repo: null means the task's repo, and an
 * unknown id falls back to it with a note in the description. `issueTargets`
 * maps a repo id to where its items can become GitHub issues.
 */
export function resolveFollowUps(
  task: Task,
  followUps: readonly FollowUp[],
  repos: readonly Pick<Repo, "id" | "name">[],
  issueTargets: ReadonlyMap<string, FollowUpIssueTarget> = new Map(),
): ResolvedFollowUp[] {
  const byId = new Map(repos.map((repo) => [repo.id, repo]));
  const own = byId.get(task.repoId);
  return followUps.map(({ title, description, repoId }) => {
    const repo = repoId === null ? own : byId.get(repoId);
    const issueTarget = issueTargets.get(repo?.id ?? task.repoId) ?? null;
    if (repo) {
      return {
        title,
        description,
        repoId: repo.id,
        repoName: repo.name,
        issueTarget,
        created: null,
      };
    }
    return {
      title,
      description: `${description}\n\nProposed for repo \`${repoId}\`, which is not registered.`,
      repoId: task.repoId,
      repoName: own?.name ?? task.repoId,
      issueTarget,
      created: null,
    };
  });
}

/**
 * The body of a follow-up created as a GitHub issue: its description and a
 * line naming the task it came from. The server adds the signature.
 */
export function followUpIssueBody(task: Task, item: Pick<ResolvedFollowUp, "description">): string {
  const ref =
    task.origin.kind === "free-text"
      ? `the blackwall task "${task.title}"`
      : `${originRef(task.origin)} "${task.title}"`;
  return `${item.description.trim()}\n\nFollow-up from ${ref}.`;
}

export interface CreateFollowUpTasksOptions {
  task: Task;
  items: readonly ResolvedFollowUp[];
  backlogItems: Repositories["backlogItems"];
}

/**
 * Creates the follow-ups as independent free-text backlog items, `waiting`
 * so a repo's backlog runner picks them up, all in one transaction.
 */
export function createFollowUpTasks({
  task,
  items,
  backlogItems,
}: CreateFollowUpTasksOptions): BacklogItem[] {
  return backlogItems.insertMany(
    items.map((item) => ({
      repoId: item.repoId,
      title: item.title,
      origin: { kind: "free-text" as const },
      mode: null,
      freeText: item.description,
      agents: {},
      agentClis: {},
      // Follow-ups use the target repo's reference repos.
      referenceRepoIds: null,
      triageMode: task.triageMode,
      inRepo: false,
      dependsOn: [],
      status: "waiting" as const,
      sourceTaskId: task.id,
    })),
  );
}
