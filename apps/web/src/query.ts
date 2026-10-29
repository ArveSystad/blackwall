import {
  DEFAULT_GITHUB_ISSUES_REFRESH_SECONDS,
  type GeneralSettings,
  type SearchScope,
  type TaskArtifact,
} from "@blackwall/shared";
import { QueryClient, keepPreviousData, queryOptions } from "@tanstack/react-query";
import {
  ApiError,
  getArtifactText,
  getBacklogRunner,
  getChat,
  getQuota,
  getRepoSync,
  getRoleDefaults,
  getSettings,
  getSystemInfo,
  getBranchDiff,
  getDeliveryPlan,
  getPullRequestComments,
  getTask,
  listActiveAgents,
  listClis,
  listArtifacts,
  getTaskWorktree,
  getVoiceDownload,
  getVoiceState,
  getVoiceStatus,
  listDiffs,
  listDoneTimes,
  listFindings,
  listQuestions,
  listRuns,
  listStepEvents,
  listSteps,
  listAgents,
  listBacklog,
  listAssignedIssues,
  listConnections,
  listMemories,
  memoryBackfillStatus,
  listRepoIssues,
  listRepoJiraIssues,
  listRepos,
  listReviewRequests,
  listTags,
  listTasks,
  listUsage,
  searchAll,
} from "./api";
import { SEARCH_MIN_CHARS } from "./search";

/**
 * Query keys. Task-scoped data nests under `["tasks", id]`, so live events can
 * invalidate one task's runs, findings or grill questions by prefix.
 */
export const queryKeys = {
  tasks: ["tasks"] as const,
  task: (id: string) => ["tasks", id] as const,
  taskRuns: (taskId: string) => ["tasks", taskId, "runs"] as const,
  taskFindings: (taskId: string) => ["tasks", taskId, "findings"] as const,
  taskGrill: (taskId: string) => ["tasks", taskId, "grill"] as const,
  taskDiffs: (taskId: string) => ["tasks", taskId, "diffs"] as const,
  taskBranchDiff: (taskId: string) => ["tasks", taskId, "branch-diff"] as const,
  taskPrComments: (taskId: string) => ["tasks", taskId, "pr-comments"] as const,
  taskArtifacts: (taskId: string) => ["tasks", taskId, "artifacts"] as const,
  /** Under the artifacts prefix, so their invalidation covers it; the mtime keys each version. */
  taskArtifactText: (taskId: string, path: string, modifiedAtMs: number) =>
    ["tasks", taskId, "artifacts", "text", path, modifiedAtMs] as const,
  taskWorktree: (taskId: string) => ["tasks", taskId, "worktree"] as const,
  taskDelivery: (taskId: string) => ["tasks", taskId, "delivery"] as const,
  runSteps: (runId: string) => ["runs", runId, "steps"] as const,
  stepEvents: (stepId: string) => ["steps", stepId, "events"] as const,
  /** Running agent steps across all tasks; any step change invalidates it. */
  activeAgents: ["active-agents"] as const,
  /** When each done task was resolved; a task reaching done or being removed invalidates it. */
  doneTimes: ["done-times"] as const,
  /** Each agent step's usage; patched live by `step.usage`/`step.upserted`, refetched when a task is removed. */
  usage: ["usage"] as const,
  repos: ["repos"] as const,
  connections: ["connections"] as const,
  agents: ["agents"] as const,
  roleDefaults: ["agents", "role-defaults"] as const,
  tags: ["tags"] as const,
  settings: ["settings"] as const,
  clis: ["clis"] as const,
  system: ["system"] as const,
  /** Every repo's backlog; `backlog.changed` invalidates one repo's by prefix. */
  backlogs: ["backlog"] as const,
  backlog: (repoId: string) => ["backlog", repoId] as const,
  backlogRunner: (repoId: string) => ["backlog", repoId, "runner"] as const,
  /**
   * The repo's local default branch vs its origin counterpart. Under the backlog
   * prefix so `backlog.changed` and finished tasks (which may have merged into
   * the default branch) refresh it.
   */
  repoSync: (repoId: string) => ["backlog", repoId, "sync"] as const,
  /** A repo's memories; only the user's own changes in Settings invalidate it. */
  memories: (repoId: string) => ["memories", repoId] as const,
  /** A repo's memory backfill; polled while a pass runs. */
  memoryBackfill: (repoId: string) => ["memories", repoId, "backfill"] as const,
  quota: ["quota"] as const,
  /** A repo's chat (`taskId` null) or a task's own; written in place by `chat.upserted`. */
  chat: (repoId: string, taskId?: string | null) => ["chat", repoId, taskId ?? null] as const,
  /** Whether the server can transcribe; saving the voice model or a finished download invalidates it. */
  voiceStatus: ["voice", "status"] as const,
  /** The speech model download; written in place by `voice.download`. */
  voiceDownload: ["voice", "download"] as const,
  /** Voice control's last command and draft; written in place by `voice.upserted`. */
  voice: ["voice", "state"] as const,
  reviewRequests: ["review-requests"] as const,
  assignedIssues: ["assigned-issues"] as const,
  repoIssues: (repoId: string) => ["repo-issues", repoId] as const,
  /** Keyed by the repo's Jira project too; `["repo-jira-issues", repoId]` matches every project. */
  repoJiraIssues: (repoId: string, jiraProject: string | null) =>
    ["repo-jira-issues", repoId, jiraProject] as const,
  search: (q: string, repoId: string | null, scope: SearchScope) =>
    ["search", q, repoId, scope] as const,
};

export const tasksQuery = queryOptions({ queryKey: queryKeys.tasks, queryFn: listTasks });

export const taskQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.task(id), queryFn: () => getTask(id) });

export const taskRunsQuery = (taskId: string) =>
  queryOptions({ queryKey: queryKeys.taskRuns(taskId), queryFn: () => listRuns(taskId) });

export const runStepsQuery = (taskId: string, runId: string) =>
  queryOptions({ queryKey: queryKeys.runSteps(runId), queryFn: () => listSteps(taskId, runId) });

/** Appended to live by `step.event`, so it never goes stale once loaded. */
export const stepEventsQuery = (taskId: string, stepId: string) =>
  queryOptions({
    queryKey: queryKeys.stepEvents(stepId),
    queryFn: () => listStepEvents(taskId, stepId),
    staleTime: Infinity,
  });

export const activeAgentsQuery = queryOptions({
  queryKey: queryKeys.activeAgents,
  queryFn: listActiveAgents,
});

export const usageQuery = queryOptions({
  queryKey: queryKeys.usage,
  queryFn: listUsage,
});

export const doneTimesQuery = queryOptions({
  queryKey: queryKeys.doneTimes,
  queryFn: listDoneTimes,
});

export const taskFindingsQuery = (taskId: string) =>
  queryOptions({ queryKey: queryKeys.taskFindings(taskId), queryFn: () => listFindings(taskId) });

export const taskGrillQuery = (taskId: string) =>
  queryOptions({ queryKey: queryKeys.taskGrill(taskId), queryFn: () => listQuestions(taskId) });

export const taskDiffsQuery = (taskId: string) =>
  queryOptions({ queryKey: queryKeys.taskDiffs(taskId), queryFn: () => listDiffs(taskId) });

export const taskBranchDiffQuery = (taskId: string) =>
  queryOptions({
    queryKey: queryKeys.taskBranchDiff(taskId),
    queryFn: () => getBranchDiff(taskId),
  });

/** How often the Diff step-through re-reads a PR's GitHub review threads. */
export const PR_COMMENTS_REFRESH_MS = 20_000;

/**
 * The review threads already on a PR task's pull request, for the Diff
 * step-through. GitHub sends no live events, so it polls while enabled, and
 * re-reads on window focus.
 */
export const taskPrCommentsQuery = (taskId: string) =>
  queryOptions({
    queryKey: queryKeys.taskPrComments(taskId),
    queryFn: () => getPullRequestComments(taskId),
    staleTime: 10_000,
    refetchInterval: PR_COMMENTS_REFRESH_MS,
    refetchOnWindowFocus: "always",
  });

export const taskArtifactsQuery = (taskId: string) =>
  queryOptions({
    queryKey: queryKeys.taskArtifacts(taskId),
    queryFn: () => listArtifacts(taskId),
  });

/** A text artifact's contents, for its card's preview. */
export const taskArtifactTextQuery = (
  taskId: string,
  artifact: Pick<TaskArtifact, "path" | "modifiedAt">,
) =>
  queryOptions({
    queryKey: queryKeys.taskArtifactText(taskId, artifact.path, artifact.modifiedAt.getTime()),
    queryFn: () => getArtifactText(taskId, artifact),
  });

export const taskWorktreeQuery = (taskId: string) =>
  queryOptions({
    queryKey: queryKeys.taskWorktree(taskId),
    queryFn: () => getTaskWorktree(taskId),
  });

export const taskDeliveryQuery = (taskId: string) =>
  queryOptions({
    queryKey: queryKeys.taskDelivery(taskId),
    queryFn: () => getDeliveryPlan(taskId),
  });

export const reposQuery = queryOptions({ queryKey: queryKeys.repos, queryFn: listRepos });

export const connectionsQuery = queryOptions({
  queryKey: queryKeys.connections,
  queryFn: listConnections,
});

export const agentsQuery = queryOptions({ queryKey: queryKeys.agents, queryFn: listAgents });

export const roleDefaultsQuery = queryOptions({
  queryKey: queryKeys.roleDefaults,
  queryFn: getRoleDefaults,
});

/** Detected once at server start, so it never goes stale within a session. */
export const clisQuery = queryOptions({
  queryKey: queryKeys.clis,
  queryFn: listClis,
  staleTime: Infinity,
});

export const systemQuery = queryOptions({
  queryKey: queryKeys.system,
  queryFn: () => getSystemInfo(),
});

export const tagsQuery = queryOptions({ queryKey: queryKeys.tags, queryFn: listTags });

export const settingsQuery = queryOptions({ queryKey: queryKeys.settings, queryFn: getSettings });

export const backlogQuery = (repoId: string) =>
  queryOptions({ queryKey: queryKeys.backlog(repoId), queryFn: () => listBacklog(repoId) });

export const memoriesQuery = (repoId: string) =>
  queryOptions({ queryKey: queryKeys.memories(repoId), queryFn: () => listMemories(repoId) });

export const memoryBackfillQuery = (repoId: string) =>
  queryOptions({
    queryKey: queryKeys.memoryBackfill(repoId),
    queryFn: () => memoryBackfillStatus(repoId),
  });

export const backlogRunnerQuery = (repoId: string) =>
  queryOptions({
    queryKey: queryKeys.backlogRunner(repoId),
    queryFn: () => getBacklogRunner(repoId),
  });

/** Also re-read on window focus, since main may have been pushed from a terminal. */
export const repoSyncQuery = (repoId: string) =>
  queryOptions({
    queryKey: queryKeys.repoSync(repoId),
    queryFn: () => getRepoSync(repoId),
    refetchOnWindowFocus: "always",
  });

/** Rechecked now and then: the model may be downloaded while blackwall runs. */
export const voiceStatusQuery = queryOptions({
  queryKey: queryKeys.voiceStatus,
  queryFn: getVoiceStatus,
  staleTime: 60_000,
});

/** Written in place by `voice.download`, so it never goes stale once loaded. */
export const voiceDownloadQuery = queryOptions({
  queryKey: queryKeys.voiceDownload,
  queryFn: getVoiceDownload,
  staleTime: Infinity,
});

/** Written in place by `voice.upserted`, so it never goes stale once loaded. */
export const voiceQuery = queryOptions({
  queryKey: queryKeys.voice,
  queryFn: getVoiceState,
  staleTime: Infinity,
});

/** Written in place by `chat.upserted`, so it never goes stale once loaded. */
export const chatQuery = (repoId: string, taskId?: string) =>
  queryOptions({
    queryKey: queryKeys.chat(repoId, taskId),
    queryFn: () => getChat(repoId, taskId),
    staleTime: Infinity,
  });

/** Written in place by `quota.changed`. */
export const quotaQuery = queryOptions({ queryKey: queryKeys.quota, queryFn: getQuota });

/**
 * Open PRs waiting on the user's review. GitHub sends no live events, so it
 * polls, and re-reads on window focus.
 */
export const reviewRequestsQuery = queryOptions({
  queryKey: queryKeys.reviewRequests,
  queryFn: listReviewRequests,
  staleTime: 120_000,
  refetchInterval: 300_000,
  refetchOnWindowFocus: "always",
});

/** The user's GitHub issues refresh interval, or the default until settings load. */
export function issuesRefreshSeconds(
  settings?: Pick<GeneralSettings, "githubIssuesRefreshSeconds">,
): number {
  return settings?.githubIssuesRefreshSeconds ?? DEFAULT_GITHUB_ISSUES_REFRESH_SECONDS;
}

/** Poll every `refreshSeconds`; never stale for longer than two minutes. */
function issuesPolling(refreshSeconds: number) {
  return {
    staleTime: Math.min(refreshSeconds * 1000, 120_000),
    refetchInterval: refreshSeconds * 1000,
    refetchOnWindowFocus: "always",
  } as const;
}

/**
 * Open issues assigned to the user. GitHub sends no live events, so it polls
 * at the user's GitHub issues refresh interval, and re-reads on window focus.
 */
export const assignedIssuesQuery = (refreshSeconds: number) =>
  queryOptions({
    queryKey: queryKeys.assignedIssues,
    queryFn: listAssignedIssues,
    ...issuesPolling(refreshSeconds),
  });

/**
 * A repo's open GitHub issues, whoever they are assigned to. GitHub sends no
 * live events, so it polls at the user's GitHub issues refresh interval, and
 * re-reads on window focus.
 */
export const repoIssuesQuery = (repoId: string, refreshSeconds: number) =>
  queryOptions({
    queryKey: queryKeys.repoIssues(repoId),
    queryFn: () => listRepoIssues(repoId),
    ...issuesPolling(refreshSeconds),
  });

/**
 * A repo's open Jira issues, unassigned or assigned to the user. Jira sends no
 * live events either, so it polls at the GitHub issues refresh interval. The
 * project is part of the key, so a project change refetches and a cleared
 * project holds no data.
 */
export const repoJiraIssuesQuery = (
  repoId: string,
  jiraProject: string | null,
  refreshSeconds: number,
) =>
  queryOptions({
    queryKey: queryKeys.repoJiraIssues(repoId, jiraProject),
    queryFn: () => listRepoJiraIssues(repoId),
    enabled: jiraProject !== null,
    ...issuesPolling(refreshSeconds),
  });

/** Fresh on every query change; the previous results stay up while the next ones load. */
export const searchQuery = (q: string, repoId: string | null, scope: SearchScope) =>
  queryOptions({
    queryKey: queryKeys.search(q, repoId, scope),
    queryFn: () => searchAll({ q, repoId, scope }),
    enabled: q.trim().length >= SEARCH_MIN_CHARS,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Live events keep the cache fresh; a reconnect invalidates everything.
        staleTime: 60_000,
        // A 4xx will not fix itself on retry.
        retry: (failures, error) =>
          !(error instanceof ApiError && error.status < 500) && failures < 2,
      },
    },
  });
}
