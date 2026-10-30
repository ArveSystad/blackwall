import {
  MAX_FOLLOW_UPS,
  type BacklogItem,
  type DeliveryAction,
  type FollowUp,
  type Repo,
  type Task,
} from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";

/** A follow-up as offered at finish: its target repo resolved to a registered one. */
export type ResolvedFollowUp = Extract<DeliveryAction, { kind: "create-tasks" }>["items"][number];

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
    "Work that belongs outside this task can become follow-up tasks, created in a repo's backlog when the user confirms them at finish. Each names its target repo by id, or null for this task's repo. The registered repos:",
    "",
    ...list,
    "",
    "- Each follow-up must be independent: it can start, be implemented and be merged on its own, in any order, alongside the others.",
    "- Do not split a sequence into separate follow-ups. Propose one follow-up for the first step; its description states the later steps and tells that task to propose them as its own follow-ups once it is done.",
    `- Prefer fewer, self-contained follow-ups over many small coupled ones; at most ${MAX_FOLLOW_UPS}.`,
  ].join("\n");
}

/**
 * The follow-ups with their target repo: null means the task's repo, and an
 * unknown id falls back to it with a note in the description.
 */
export function resolveFollowUps(
  task: Task,
  followUps: readonly FollowUp[],
  repos: readonly Pick<Repo, "id" | "name">[],
): ResolvedFollowUp[] {
  const byId = new Map(repos.map((repo) => [repo.id, repo]));
  const own = byId.get(task.repoId);
  return followUps.map(({ title, description, repoId }) => {
    const repo = repoId === null ? own : byId.get(repoId);
    if (repo) return { title, description, repoId: repo.id, repoName: repo.name };
    return {
      title,
      description: `${description}\n\nProposed for repo \`${repoId}\`, which is not registered.`,
      repoId: task.repoId,
      repoName: own?.name ?? task.repoId,
    };
  });
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
