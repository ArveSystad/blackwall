import {
  DELIVERY_TARGETS,
  type DeliveryAction,
  type DeliveryConfirmation,
  type DeliveryPlan,
  type DeliverySquash,
  type DeliveryTarget,
  type Finding,
  type Run,
  type Task,
} from "@blackwall/shared";
import { MissingCredentialError } from "../connections/service.js";
import type { Repositories } from "../db/repositories.js";
import type { GitService } from "../git/service.js";
import { createFollowUpTasks, resolveFollowUps } from "./follow-ups.js";
import { commitKey } from "./stages.js";
import { InvalidGateResponseError, pipelineKind } from "./transitions.js";

/** A confirmed delivery action failed. The message is safe to show the user. */
export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryError";
  }
}

/** What delivery performs: an action the user confirmed, or the squash before them. */
export type DeliveryStep = DeliveryTarget | "squash";

/** Step event logged for each delivery action performed. */
export const DELIVERY_DONE_EVENT = "delivery.done";

/** Step event logged when a delivery action fails. */
export const DELIVERY_FAILED_EVENT = "delivery.failed";

/** Step event logged when the rebase onto main stops on conflicts the implementer resolves. */
export const DELIVERY_CONFLICT_EVENT = "delivery.conflict";

/** Payload of a {@link DELIVERY_CONFLICT_EVENT}: the rebase that stopped and its conflicted files. */
export interface MergeConflict {
  branch: string;
  into: string;
  files: string[];
}

/** Payload of a {@link DELIVERY_DONE_EVENT}: the action, and where it went (a link, a sha, a branch). */
export interface DeliveryOutcome {
  action: DeliveryStep;
  detail: string;
}

/**
 * Step event logged when a GitHub issue task comments on its issue during the
 * run (at plan approval), on the step the task waited on.
 */
export const ISSUE_COMMENT_EVENT = "issue.commented";

/** Payload of an {@link ISSUE_COMMENT_EVENT}: the comment's link and when it was posted. */
export interface IssueCommentOutcome {
  url: string;
  at: "plan-approval";
}

/** Host and `owner/repo` of a GitHub/GHE remote. */
export interface RemoteSlug {
  host: string;
  owner: string;
  repo: string;
}

export type OpenPullRequestAction = Extract<DeliveryAction, { kind: "open-pr" }>;

/**
 * The outward calls delivery makes, implemented by the server with the
 * GitHub/GHE and Jira clients and the task's connections.
 */
export interface DeliveryPorts {
  /** Host and `owner/repo` of a git remote URL; undefined when it is not one. */
  parseRemote(remoteUrl: string): RemoteSlug | undefined;
  /** Web link of a Jira issue, when the task's Jira site is known. */
  jiraIssueUrl?(task: Task): string | undefined;
  openPullRequest(task: Task, action: OpenPullRequestAction): Promise<{ url: string }>;
  /** Posts `body` as a conversation comment on the task's pull request. */
  commentOnPullRequest(task: Task, body: string): Promise<{ url: string }>;
  /** Posts `body` as a comment on the task's Jira issue. Never transitions it. */
  commentOnJiraIssue(task: Task, body: string): Promise<{ url: string | null }>;
  /** Posts `body` as a comment on the task's GitHub issue. */
  commentOnGitHubIssue(task: Task, body: string): Promise<{ url: string }>;
  /** Submits a review on the task's pull request with `findings` as inline comments. */
  reviewPullRequest(task: Task, findings: readonly Finding[]): Promise<{ url: string }>;
}

export type DeliveryGit = Pick<
  GitService,
  "mainBranch" | "isProtected" | "mergeBase" | "commitsSince" | "squash" | "push" | "finishIntoMain"
>;

/** What the engine hands delivery when the user confirms. */
export interface DeliveryContext {
  task: Task;
  run: Run;
  confirmation: DeliveryConfirmation;
  /** Actions already performed for this run; a retry after a failure skips them. */
  completed: readonly DeliveryStep[];
  /** Logs one performed action, as soon as it is done. */
  record(outcome: DeliveryOutcome): void;
  /**
   * Has the task's implementer resolve one stop of the rebase onto main in
   * the worktree. Rejects when it could not.
   */
  resolveConflicts(conflict: MergeConflict): Promise<void>;
}

/** Plans and performs the finish actions; the engine calls it at the delivery gate. */
export interface Deliverer {
  plan(task: Task, completed: readonly DeliveryStep[]): Promise<DeliveryPlan>;
  deliver(ctx: DeliveryContext): Promise<void>;
  /**
   * Posts a comment the user confirmed on a GitHub issue task's issue during
   * the run. Refuses any other task.
   */
  commentOnIssue(task: Task, body: string): Promise<{ url: string }>;
}

export interface DelivererOptions {
  git: DeliveryGit;
  repositories: Pick<Repositories, "repos" | "findings" | "backlogItems">;
  ports: DeliveryPorts;
  /** Called once per repo that `create-tasks` added backlog items to. */
  onBacklogChanged?(repoId: string): void;
}

/** Actions that send or merge the branch's code; dropped when the branch has no commits. */
const CODE_ACTIONS: readonly DeliveryTarget[] = ["push-branch", "open-pr", "merge-main"];

/** Findings a Review PR task offers for posting: everything still active, ignored ones excepted. */
export function postableFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.status === "open" || f.status === "force-fix");
}

function prTitle(task: Task): string {
  const key = commitKey(task);
  return key && !task.title.toUpperCase().startsWith(key) ? `${key} ${task.title}` : task.title;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Prompt for the implementer resolving a stop of the rebase onto main. */
export function conflictResolutionPrompt(
  task: Task,
  { branch, into, files }: MergeConflict,
): string {
  const summary = task.summary?.trim();
  return [
    `Blackwall is rebasing this task's branch \`${branch}\` onto \`${into}\` to merge it, and the rebase stopped on conflicts in:`,
    ...files.map((f) => `- ${f}`),
    "",
    `The task: ${task.title}`,
    ...(summary ? ["", summary] : []),
    "",
    `Resolve the conflicts in the worktree. Keep the changes from \`${into}\` and reapply this task's intent on top of them. Remove every conflict marker (<<<<<<<, |||||||, =======, >>>>>>>).`,
    "If a file was deleted on one side and changed on the other, either keep the file with the right content or delete it.",
    "Only edit or delete the conflicted files as needed. Do not run `git add`, `git commit`, `git rebase` or any other git command that changes the index or history, and make no unrelated changes: blackwall stages your resolution and continues the rebase.",
  ].join("\n");
}

/**
 * Delivery at finish (AGENTS.md, Design rules). The plan lists each action with
 * its exact target: a PR task pushes its branch and comments on the PR, a
 * Jira task pushes its branch, opens a PR and comments on the issue (no
 * transitions), a GitHub issue task does the same with a PR body that ends
 * `Closes owner/repo#n`, a free-text task rebases onto local main, resolving conflicts
 * with the implementer, and fast-forwards it (main is never pushed), and a
 * Review PR task posts the selected findings
 * as a review. Any task with follow-ups the summarizer proposed also offers
 * `create-tasks`, last, which adds the picked ones to their repos' backlogs
 * as waiting items; it needs no worktree. A branch with no commits of its own
 * (an analysis-only task) offers no push, PR or merge, and a protected head
 * branch (main, master or the configured main) offers no push or PR. Only the
 * actions the user confirmed are performed, in that order, after an optional
 * squash.
 */
export function createDeliverer({
  git,
  repositories: r,
  ports,
  onBacklogChanged,
}: DelivererOptions): Deliverer {
  /** Where the task's own commits start: the PR head on the remote, or the fork point from main. */
  async function squashBase(task: Task, worktree: string): Promise<string | undefined> {
    const refs =
      task.origin.kind === "github-pr"
        ? [`origin/${task.branch}`]
        : [git.mainBranch, `origin/${git.mainBranch}`];
    for (const ref of refs) {
      try {
        return await git.mergeBase(worktree, ref);
      } catch {
        // Try the next ref.
      }
    }
    return undefined;
  }

  async function squashPlan(
    task: Task,
    completed: readonly DeliveryStep[],
  ): Promise<DeliverySquash | null> {
    const worktree = task.worktreePath;
    // Squashing after the push would rewrite what was already sent.
    if (!worktree || completed.includes("push-branch")) return null;
    const base = await squashBase(task, worktree);
    if (!base) return null;
    const commits = await git.commitsSince(worktree, base);
    if (commits < 2) return null;
    return { commits, base, message: task.squashMessage ?? prTitle(task) };
  }

  function actions(task: Task): DeliveryAction[] {
    const { origin, branch } = task;
    if (pipelineKind(task.mode) === "review") {
      if (origin.kind !== "github-pr") return [];
      const findingIds = postableFindings(r.findings.listByTask(task.id)).map((f) => f.id);
      return [{ kind: "pr-review", url: origin.url, findingIds }];
    }
    if (!branch) return [];
    const body = task.summary?.trim() || task.title;
    const remoteUrl = r.repos.get(task.repoId)?.remoteUrl ?? null;
    // The harness never pushes a protected branch, so it is not offered.
    const push: DeliveryAction[] =
      remoteUrl && !git.isProtected(branch)
        ? [{ kind: "push-branch", branch, remote: remoteUrl }]
        : [];
    /** Opening a PR from the pushed branch, when the remote is a GitHub/GHE repo. */
    const openPr = (prBody: string): DeliveryAction[] => {
      if (push.length === 0) return [];
      const slug = remoteUrl ? ports.parseRemote(remoteUrl) : undefined;
      return slug
        ? [
            {
              kind: "open-pr",
              ...slug,
              head: branch,
              base: git.mainBranch,
              title: prTitle(task),
              body: prBody,
            },
          ]
        : [];
    };

    switch (origin.kind) {
      case "free-text":
        return [{ kind: "merge-main", branch, into: git.mainBranch }];
      case "github-pr":
        return [...push, { kind: "pr-comment", url: origin.url, body }];
      case "jira-issue":
        return [
          ...push,
          ...openPr(body),
          { kind: "jira-comment", key: origin.key, url: ports.jiraIssueUrl?.(task) ?? null, body },
        ];
      case "github-issue":
        // The full reference links (and on merge closes) the issue even from another repo.
        return [
          ...push,
          ...openPr(`${body}\n\nCloses ${origin.owner}/${origin.repo}#${origin.number}`),
          { kind: "issue-comment", url: origin.url, body },
        ];
    }
  }

  /**
   * Whether the branch has commits since its fork point from main. Unknown
   * (no worktree, no merge base) counts as yes, so the code actions stay.
   */
  async function hasCommits(task: Task): Promise<boolean> {
    const worktree = task.worktreePath;
    if (!worktree) return true;
    const base = await squashBase(task, worktree);
    if (!base) return true;
    return (await git.commitsSince(worktree, base)) > 0;
  }

  async function plan(task: Task, completed: readonly DeliveryStep[]): Promise<DeliveryPlan> {
    const review = pipelineKind(task.mode) === "review";
    let offered = actions(task);
    const codeStarted = CODE_ACTIONS.some((a) => completed.includes(a));
    if (!review && task.origin.kind !== "github-pr" && !codeStarted && !(await hasCommits(task))) {
      offered = offered.filter((a) => !CODE_ACTIONS.includes(a.kind));
    }
    if (!review && task.followUps.length > 0) {
      const items = resolveFollowUps(task, task.followUps, r.repos.list());
      offered = [...offered, { kind: "create-tasks", items }];
    }
    return {
      actions: offered,
      squash: review ? null : await squashPlan(task, completed),
      completed: completed.filter((c): c is DeliveryTarget => c !== "squash"),
    };
  }

  /** Refuses a confirmation that does not fit the plan, before anything is done. */
  function check(
    { actions: offered, squash }: DeliveryPlan,
    confirmation: DeliveryConfirmation,
    completed: readonly DeliveryStep[],
  ): void {
    const kinds = new Set(offered.map((a) => a.kind));
    for (const action of confirmation.actions) {
      if (!kinds.has(action)) {
        throw new InvalidGateResponseError(`${action} is not a delivery action for this task`);
      }
    }
    if (confirmation.squash && !squash && !completed.includes("squash")) {
      throw new InvalidGateResponseError("There is nothing to squash");
    }
    const pushed =
      confirmation.actions.includes("push-branch") || completed.includes("push-branch");
    if (confirmation.actions.includes("open-pr") && !pushed) {
      throw new InvalidGateResponseError("Opening a pull request needs the branch pushed");
    }
    const review = offered.find((a) => a.kind === "pr-review");
    if (confirmation.findingIds.length > 0 && !confirmation.actions.includes("pr-review")) {
      throw new InvalidGateResponseError("Findings are posted only with the pr-review action");
    }
    for (const id of confirmation.findingIds) {
      if (!review?.findingIds.includes(id)) {
        throw new InvalidGateResponseError(`Finding ${id} cannot be posted`);
      }
    }
    const createTasks = offered.find((a) => a.kind === "create-tasks");
    const creating = confirmation.actions.includes("create-tasks");
    if (confirmation.followUpIndexes.length > 0 && !creating) {
      throw new InvalidGateResponseError(
        "Follow-ups are created only with the create-tasks action",
      );
    }
    for (const index of confirmation.followUpIndexes) {
      if (!createTasks || index >= createTasks.items.length) {
        throw new InvalidGateResponseError(`Follow-up ${index} is not offered`);
      }
    }
    if (
      creating &&
      !completed.includes("create-tasks") &&
      confirmation.followUpIndexes.length === 0
    ) {
      throw new InvalidGateResponseError("Pick at least one follow-up to create");
    }
  }

  async function deliver(ctx: DeliveryContext) {
    const { task, confirmation, completed, record } = ctx;
    const planned = await plan(task, completed);
    check(planned, confirmation, completed);
    const worktree = task.worktreePath;
    const target = <K extends DeliveryAction["kind"]>(kind: K) =>
      planned.actions.find((a): a is Extract<DeliveryAction, { kind: K }> => a.kind === kind)!;

    if (confirmation.squash && planned.squash && worktree && !completed.includes("squash")) {
      const sha = await git.squash(worktree, planned.squash.base, planned.squash.message);
      record({ action: "squash", detail: sha ?? planned.squash.base });
    }

    for (const action of DELIVERY_TARGETS) {
      if (!confirmation.actions.includes(action) || completed.includes(action)) continue;
      record({ action, detail: await perform(ctx, action, target) });
    }
  }

  async function perform(
    { task, confirmation, resolveConflicts }: DeliveryContext,
    action: DeliveryTarget,
    target: <K extends DeliveryAction["kind"]>(kind: K) => Extract<DeliveryAction, { kind: K }>,
  ): Promise<string> {
    // Only touches the database, so it needs no worktree.
    if (action === "create-tasks") {
      const { items } = target("create-tasks");
      const picked = confirmation.followUpIndexes.map((i) => items[i]!);
      const created = createFollowUpTasks({ task, items: picked, backlogItems: r.backlogItems });
      for (const repoId of new Set(created.map((item) => item.repoId))) {
        onBacklogChanged?.(repoId);
      }
      const names = new Map(picked.map((item) => [item.repoId, item.repoName]));
      const list = created.map((item) => `${names.get(item.repoId)}: ${item.title}`).join("; ");
      return `${created.length} ${created.length === 1 ? "task" : "tasks"}: ${list}`;
    }
    const worktree = task.worktreePath;
    if (!worktree) throw new DeliveryError("The task has no worktree");
    switch (action) {
      case "push-branch": {
        const { branch, remote } = target("push-branch");
        await git.push(worktree, branch);
        return `${remote} ${branch}`;
      }
      case "open-pr":
        return (await ports.openPullRequest(task, target("open-pr"))).url;
      case "pr-comment":
        return (await ports.commentOnPullRequest(task, target("pr-comment").body)).url;
      case "jira-comment": {
        const { key, body } = target("jira-comment");
        return (await ports.commentOnJiraIssue(task, body)).url ?? key;
      }
      case "issue-comment":
        return (await ports.commentOnGitHubIssue(task, target("issue-comment").body)).url;
      case "merge-main": {
        const { branch, into } = target("merge-main");
        const repo = r.repos.get(task.repoId);
        if (!repo) throw new DeliveryError(`Repo ${task.repoId} not found`);
        const result = await git.finishIntoMain({
          repoPath: repo.path,
          worktreePath: worktree,
          branch,
          resolve: ({ files }) => resolveConflicts({ branch, into, files }),
        });
        if (result.status === "conflict") {
          const why = result.unresolved
            ? ` The implementer could not resolve them: ${result.unresolved}.`
            : "";
          throw new DeliveryError(
            `Rebasing ${branch} onto ${into} hit conflicts in ${result.files.join(", ")}.${why} Nothing was changed: rebase the branch onto ${into} in the worktree (${worktree}), resolve the conflicts, then finish again.`,
          );
        }
        if (result.status === "not-fast-forward") {
          throw new DeliveryError(
            `${into} moved while ${branch} was rebased onto it; finish again`,
          );
        }
        return result.resolved.length > 0
          ? `${result.sha} (resolved conflicts in ${result.resolved.join(", ")})`
          : result.sha;
      }
      case "pr-review": {
        const findings = confirmation.findingIds.map((id) => {
          const finding = r.findings.get(id);
          if (!finding) throw new DeliveryError(`Finding ${id} not found`);
          return finding;
        });
        return (await ports.reviewPullRequest(task, findings)).url;
      }
    }
  }

  return {
    plan,
    async deliver(ctx) {
      try {
        await deliver(ctx);
      } catch (error) {
        // Validation and missing tokens reach the user as they are (the latter opens the token modal).
        if (
          error instanceof InvalidGateResponseError ||
          error instanceof DeliveryError ||
          error instanceof MissingCredentialError
        ) {
          throw error;
        }
        throw new DeliveryError(errorMessage(error));
      }
    },
    async commentOnIssue(task, body) {
      if (task.origin.kind !== "github-issue") {
        throw new InvalidGateResponseError("Only GitHub issue tasks comment on their issue");
      }
      try {
        return await ports.commentOnGitHubIssue(task, body);
      } catch (error) {
        // A missing token opens the token modal; anything else is the host's own message.
        if (error instanceof MissingCredentialError) throw error;
        throw new DeliveryError(errorMessage(error));
      }
    },
  };
}
