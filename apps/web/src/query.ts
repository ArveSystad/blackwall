import { QueryClient, queryOptions } from "@tanstack/react-query";
import {
  ApiError,
  getBacklogRunner,
  getQuota,
  getRoleDefaults,
  getSettings,
  getDeliveryPlan,
  getTask,
  listClis,
  listDiffs,
  listFindings,
  listQuestions,
  listRuns,
  listStepEvents,
  listSteps,
  listAgents,
  listBacklog,
  listConnections,
  listRepos,
  listTags,
  listTasks,
} from "./api";

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
  taskDelivery: (taskId: string) => ["tasks", taskId, "delivery"] as const,
  runSteps: (runId: string) => ["runs", runId, "steps"] as const,
  stepEvents: (stepId: string) => ["steps", stepId, "events"] as const,
  repos: ["repos"] as const,
  connections: ["connections"] as const,
  agents: ["agents"] as const,
  roleDefaults: ["agents", "role-defaults"] as const,
  tags: ["tags"] as const,
  settings: ["settings"] as const,
  clis: ["clis"] as const,
  /** Every repo's backlog; `backlog.changed` invalidates one repo's by prefix. */
  backlogs: ["backlog"] as const,
  backlog: (repoId: string) => ["backlog", repoId] as const,
  backlogRunner: (repoId: string) => ["backlog", repoId, "runner"] as const,
  quota: ["quota"] as const,
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

export const taskFindingsQuery = (taskId: string) =>
  queryOptions({ queryKey: queryKeys.taskFindings(taskId), queryFn: () => listFindings(taskId) });

export const taskGrillQuery = (taskId: string) =>
  queryOptions({ queryKey: queryKeys.taskGrill(taskId), queryFn: () => listQuestions(taskId) });

export const taskDiffsQuery = (taskId: string) =>
  queryOptions({ queryKey: queryKeys.taskDiffs(taskId), queryFn: () => listDiffs(taskId) });

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

export const tagsQuery = queryOptions({ queryKey: queryKeys.tags, queryFn: listTags });

export const settingsQuery = queryOptions({ queryKey: queryKeys.settings, queryFn: getSettings });

export const backlogQuery = (repoId: string) =>
  queryOptions({ queryKey: queryKeys.backlog(repoId), queryFn: () => listBacklog(repoId) });

export const backlogRunnerQuery = (repoId: string) =>
  queryOptions({
    queryKey: queryKeys.backlogRunner(repoId),
    queryFn: () => getBacklogRunner(repoId),
  });

/** Written in place by `quota.changed`. */
export const quotaQuery = queryOptions({ queryKey: queryKeys.quota, queryFn: getQuota });

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
