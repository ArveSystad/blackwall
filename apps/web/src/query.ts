import { QueryClient, queryOptions } from "@tanstack/react-query";
import {
  ApiError,
  getRoleDefaults,
  getSettings,
  getTask,
  listAgents,
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
  runSteps: (runId: string) => ["runs", runId, "steps"] as const,
  stepEvents: (stepId: string) => ["steps", stepId, "events"] as const,
  repos: ["repos"] as const,
  connections: ["connections"] as const,
  agents: ["agents"] as const,
  roleDefaults: ["agents", "role-defaults"] as const,
  tags: ["tags"] as const,
  settings: ["settings"] as const,
};

export const tasksQuery = queryOptions({ queryKey: queryKeys.tasks, queryFn: listTasks });

export const taskQuery = (id: string) =>
  queryOptions({ queryKey: queryKeys.task(id), queryFn: () => getTask(id) });

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

export const tagsQuery = queryOptions({ queryKey: queryKeys.tags, queryFn: listTags });

export const settingsQuery = queryOptions({ queryKey: queryKeys.settings, queryFn: getSettings });

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
