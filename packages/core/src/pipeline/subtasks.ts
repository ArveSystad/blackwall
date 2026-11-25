import {
  MAX_SUBTASKS,
  MAX_TITLE_CHARS,
  subtaskSchema,
  type Repo,
  type Subtask,
  type Task,
} from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";
import { pipelineKind } from "./transitions.js";

type RepoRef = Pick<Repo, "id" | "name">;

/**
 * Whether the planner may split the task into subtasks: a work task that is
 * not a pull request's, not a subtask itself (no nesting), with at least one
 * registered reference repo to split into.
 */
export function canSplit(
  task: Pick<Task, "mode" | "origin" | "parentTaskId" | "referenceRepoIds" | "repoId">,
  repos: readonly Pick<Repo, "id">[],
): boolean {
  if (pipelineKind(task.mode) !== "work") return false;
  if (task.origin.kind === "github-pr") return false;
  if (task.parentTaskId !== null) return false;
  const registered = new Set(repos.map((repo) => repo.id));
  return task.referenceRepoIds.some((id) => id !== task.repoId && registered.has(id));
}

/** The repos a task may split into, by id: its own repo, then its registered reference repos. */
export function splitTargets<R extends Pick<Repo, "id">>(
  task: Pick<Task, "repoId" | "referenceRepoIds">,
  repos: readonly R[],
): R[] {
  const byId = new Map(repos.map((repo) => [repo.id, repo]));
  const ids = [...new Set([task.repoId, ...task.referenceRepoIds])];
  return ids.flatMap((id) => {
    const repo = byId.get(id);
    return repo ? [repo] : [];
  });
}

/**
 * The prompt section on subtasks: the repos the task may split into, by id,
 * and how to list one part per repo. Empty when the task can't be split.
 */
export function subtasksPromptSection(repos: readonly RepoRef[], task: Task): string {
  if (!canSplit(task, repos)) return "";
  const list = splitTargets(task, repos).map(
    (repo) =>
      `- \`${repo.id}\`: ${repo.name}${repo.id === task.repoId ? " (this task's repo)" : ""}`,
  );
  return [
    "## Subtasks",
    "",
    "This task may need changes in more than one of these repos:",
    "",
    ...list,
    "",
    "- When changes are needed in more than one of them, split the plan: add a `### Subtasks` heading with one list item per repo that needs changes, each giving the repo id, a title and that repo's part of the plan, including the contracts the parts share (APIs, payloads, names). When the plan is approved each item starts as its own task in its repo, and they run in parallel.",
    "- At most one subtask per repo, and only the repos listed above.",
    "- When you split, write `None.` under `### Follow-up tasks`: this task never implements or finishes code itself. Work that must wait goes into the description of the subtask it depends on, as follow-ups for that subtask to propose when it is done.",
    "- When only this task's repo needs changes, leave out the `### Subtasks` heading.",
  ].join("\n");
}

/** The planner's prompt to turn the plan's `### Subtasks` section into data. */
export function subtasksExtractionPrompt(): string {
  return [
    "Return the items under the plan's `### Subtasks` heading as `subtasks`, one entry per item, in order: its repo id (`repoId`, exactly as listed), a title (`title`, at most " +
      `${MAX_TITLE_CHARS} characters) and that repo's part of the plan (\`description\`), complete enough to plan and build from on its own, with the contracts the parts share.`,
    "If the plan still lists items under `### Follow-up tasks`, add a paragraph starting `Follow-ups to propose:` to the description of the subtask in the same repo as each item, or else to the first subtask, listing them for that subtask to propose when it is done.",
    'Reply with a JSON object `{ "subtasks": [{ "repoId": "<repo id>", "title": "<short title>", "description": "<markdown>" }] }`.',
  ].join("\n");
}

/** Whether a plan has a `### Subtasks` heading. */
export function hasSubtasksHeading(plan: string | null | undefined): boolean {
  return plan ? /^###\s+Subtasks\s*$/im.test(plan) : false;
}

/** A planner's subtask entry that was not kept, and why. */
export interface DroppedSubtask {
  index: number;
  reason: "invalid" | "unknown-repo" | "duplicate-repo" | "over-limit";
}

/**
 * The subtasks of the planner's answer: valid entries whose repo is the
 * task's own or one of its registered reference repos, the first per repo, at
 * most {@link MAX_SUBTASKS}. None when no kept entry leaves the task's repo,
 * since a split within one repo is just the plan.
 */
export function parseSubtasks(
  raw: unknown,
  {
    task,
    repos,
  }: { task: Pick<Task, "repoId" | "referenceRepoIds">; repos: readonly Pick<Repo, "id">[] },
): { subtasks: Subtask[]; dropped: DroppedSubtask[] } {
  const list =
    typeof raw === "object" &&
    raw !== null &&
    Array.isArray((raw as { subtasks?: unknown }).subtasks)
      ? (raw as { subtasks: unknown[] }).subtasks
      : Array.isArray(raw)
        ? raw
        : [];
  const targets = new Set(splitTargets(task, repos).map((repo) => repo.id));
  const subtasks: Subtask[] = [];
  const dropped: DroppedSubtask[] = [];
  list.forEach((entry: unknown, index) => {
    const parsed = subtaskSchema.safeParse(entry);
    if (!parsed.success) dropped.push({ index, reason: "invalid" });
    else if (!targets.has(parsed.data.repoId)) dropped.push({ index, reason: "unknown-repo" });
    else if (subtasks.some((s) => s.repoId === parsed.data.repoId)) {
      dropped.push({ index, reason: "duplicate-repo" });
    } else if (subtasks.length >= MAX_SUBTASKS) dropped.push({ index, reason: "over-limit" });
    else subtasks.push(parsed.data);
  });
  if (!subtasks.some((s) => s.repoId !== task.repoId)) return { subtasks: [], dropped };
  return { subtasks, dropped };
}

/** The tasks split from `parentId`, oldest first. */
export function childTasks(repositories: Pick<Repositories, "tasks">, parentId: string): Task[] {
  return repositories.tasks.list().filter((t) => t.parentTaskId === parentId);
}

/**
 * The prompt section a subtask reads about the task it was split from: the
 * parent's title, details and approved plan, and its sibling subtasks. Empty
 * for a task that is not a subtask or whose parent is gone.
 */
export function parentTaskSection(
  repositories: Pick<Repositories, "tasks" | "repos">,
  task: Pick<Task, "id" | "parentTaskId">,
): string {
  if (task.parentTaskId === null) return "";
  const parent = repositories.tasks.get(task.parentTaskId);
  if (!parent) return "";
  const repoName = (id: string) => repositories.repos.get(id)?.name ?? id;
  const siblings = childTasks(repositories, parent.id)
    .filter((t) => t.id !== task.id)
    .map((t) => `- ${repoName(t.repoId)}: ${t.title}`);
  const details = parent.freeText.trim();
  const plan = parent.plan?.trim();
  return [
    `## Parent task\n\nThis task is one subtask of "${parent.title}", which was split across repos.`,
    details ? `### Details\n\n${details}` : "",
    plan ? `### Approved plan\n\n${plan}` : "",
    siblings.length > 0 ? `### Sibling subtasks\n\n${siblings.join("\n")}` : "",
    "Plan and build only this repository's part; propose the follow-ups your description lists.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The comment a split parent offers on its issue once every subtask is done:
 * one line per subtask with its pull request, or how it was delivered.
 */
export function subtaskReport(
  repositories: Pick<Repositories, "repos">,
  children: readonly Task[],
  prUrl: (taskId: string) => string | undefined,
): string {
  const lines = children.map((child) => {
    const repo = repositories.repos.get(child.repoId);
    const url = prUrl(child.id);
    const link = url
      ? url
      : child.deliveryTargets.includes("merge-main")
        ? `merged into \`${repo?.defaultBranch ?? "main"}\` locally`
        : "no pull request";
    return `- ${repo?.name ?? child.repoId}: ${child.title} — ${link}`;
  });
  return ["Solved with these pull requests:", "", ...lines].join("\n");
}
