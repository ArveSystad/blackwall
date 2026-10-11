import type { Task } from "@blackwall/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MissingCredentialError, resumeTask } from "../api";
import { useWithCredential } from "../credentials";
import { originKey } from "../inbox";
import { queryKeys } from "../query";
import { errorMessage } from "../settings-forms";

/** How long a resume or retry boom plays; mirrors `.bw-revive` in styles.css. */
export const REVIVE_MS = 1200;

/** One-shot boom on a dot: cyan as a resume starts, red when it fails. */
export interface ReviveBurst {
  /** Bumped on every boom; part of the React key, so a new boom replays the animation. */
  count: number;
  tone: "running" | "failed";
}

/** Interrupted and failed dots being resumed, and the last resume error; see `useResumeBursts`. */
export interface ResumeBursts {
  /** The boom each dot plays, by task id, until `REVIVE_MS` has passed. */
  bursts: ReadonlyMap<string, ReviveBurst>;
  /** Tasks whose resume was asked for and that have not run yet. */
  waiting: ReadonlySet<string>;
  error: string | null;
  /** Clears the last resume error, as another grid action starts. */
  clearError: () => void;
  /** Polite status text while a resume request is in flight. */
  announcement: string | null;
  /** Resumes an interrupted task, or retries a failed one; a missing token opens the token modal. */
  resume: (task: Task) => void;
}

/**
 * Resuming interrupted and failed dots from the grid (`GridAgents`). The dot
 * booms cyan at once and keeps a faint ring while it waits to run; a request
 * that fails booms it red. A boom is dropped after `REVIVE_MS` (a timeout,
 * since reduced motion turns the animation off), so a remount can't replay it.
 * A task stops waiting on the first tasks snapshot after its request settles
 * that does not show it queued.
 */
export function useResumeBursts(tasks: ReadonlyMap<string, Task>): ResumeBursts {
  const queryClient = useQueryClient();
  const withCredential = useWithCredential();
  const [bursts, setBursts] = useState<ReadonlyMap<string, ReviveBurst>>(new Map());
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  // Guards a double Ctrl+click before the first one renders.
  const pending = useRef(new Set<string>());
  const counts = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, number>());
  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const timer of running.values()) window.clearTimeout(timer);
      running.clear();
    };
  }, []);

  // On each tasks snapshot, a task keeps waiting while its request is in flight or it is queued.
  const [seenTasks, setSeenTasks] = useState(tasks);
  if (tasks !== seenTasks) {
    setSeenTasks(tasks);
    const kept = [...waiting].filter(
      (id) => inFlight.has(id) || tasks.get(id)?.status === "queued",
    );
    if (kept.length !== waiting.size) setWaiting(new Set(kept));
  }

  const drop = useCallback((taskId: string) => {
    window.clearTimeout(timers.current.get(taskId));
    timers.current.delete(taskId);
    setBursts((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
  }, []);

  const bump = useCallback(
    (taskId: string, tone: ReviveBurst["tone"]) => {
      const count = (counts.current.get(taskId) ?? 0) + 1;
      counts.current.set(taskId, count);
      setBursts((prev) => new Map(prev).set(taskId, { count, tone }));
      window.clearTimeout(timers.current.get(taskId));
      timers.current.set(
        taskId,
        window.setTimeout(() => drop(taskId), REVIVE_MS),
      );
    },
    [drop],
  );

  const clearError = useCallback(() => setError(null), []);

  const resume = useCallback(
    (task: Task) => {
      const retry = task.status === "failed";
      if (pending.current.has(task.id)) return;
      pending.current.add(task.id);
      setInFlight((prev) => new Set(prev).add(task.id));
      bump(task.id, "running");
      setWaiting((prev) => new Set(prev).add(task.id));
      setError(null);
      setAnnouncement(`${retry ? "Retrying" : "Resuming"} ${task.title}`);
      withCredential({ label: retry ? "Retry" : "Resume", target: originKey(task) }, () =>
        resumeTask(task.id),
      )
        .catch((cause: unknown) => {
          bump(task.id, "failed");
          setWaiting((prev) => {
            const next = new Set(prev);
            next.delete(task.id);
            return next;
          });
          setError(
            `Could not ${retry ? "retry" : "resume"} ${task.title}: ${
              cause instanceof MissingCredentialError
                ? "Cancelled: no token saved"
                : errorMessage(cause)
            }`,
          );
        })
        .finally(() => {
          setAnnouncement(null);
          pending.current.delete(task.id);
          setInFlight((prev) => {
            const next = new Set(prev);
            next.delete(task.id);
            return next;
          });
          void queryClient.invalidateQueries({ queryKey: queryKeys.tasks, exact: true });
        });
    },
    [bump, queryClient, withCredential],
  );

  return useMemo(
    () => ({ bursts, waiting, error, clearError, announcement, resume }),
    [bursts, waiting, error, clearError, announcement, resume],
  );
}
