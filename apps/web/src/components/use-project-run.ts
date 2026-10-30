import type { ProjectRun, RepoView } from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { startProjectRun, stopProjectRun } from "../api";
import { runButtonState } from "../project-run";
import { projectRunsQuery, queryKeys } from "../query";
import { errorMessage } from "../settings-forms";

export type ProjectRunControl = ReturnType<typeof useProjectRun>;

/**
 * The repo's latest Run project run, its button state, and the start/stop
 * action the top bar and the output window share. `error` is why the last
 * start or stop failed.
 */
export function useProjectRun(repo: RepoView) {
  const queryClient = useQueryClient();
  const runs = useQuery(projectRunsQuery);
  const run = runs.data?.find((r) => r.repoId === repo.id);
  const state = runButtonState(repo, run);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act() {
    setPending(true);
    setError(null);
    try {
      if (state.mainAction === "stop") {
        await stopProjectRun(repo.id);
      } else {
        const started = await startProjectRun(repo.id);
        queryClient.setQueryData<ProjectRun[]>(queryKeys.projectRuns, (list) =>
          list ? [...list.filter((r) => r.repoId !== repo.id), started] : [started],
        );
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return { run, state, pending, error, act };
}
