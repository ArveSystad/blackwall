import type { Task } from "@blackwall/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { MissingCredentialError } from "../../api";
import { useWithCredential } from "../../credentials";
import { queryKeys } from "../../query";
import { errorMessage } from "../../settings-forms";
import { originKey } from "../../inbox";

export interface TaskAction {
  pending: boolean;
  error: string | null;
  /** Runs an action that answers with the updated task; a missing token opens the token modal. */
  run: (label: string, action: () => Promise<Task>) => Promise<Task | undefined>;
  clearError: () => void;
}

/** Task actions (gate answers, resume) with a pending flag and a showable error. */
export function useTaskAction(task: Task): TaskAction {
  const queryClient = useQueryClient();
  const withCredential = useWithCredential();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, action: () => Promise<Task>) {
    setPending(true);
    setError(null);
    try {
      const updated = await withCredential({ label, target: originKey(task) }, action);
      queryClient.setQueryData(queryKeys.task(updated.id), updated);
      return updated;
    } catch (cause) {
      setError(
        cause instanceof MissingCredentialError ? "Cancelled: no token saved" : errorMessage(cause),
      );
      return undefined;
    } finally {
      setPending(false);
    }
  }

  return { pending, error, run, clearError: () => setError(null) };
}
