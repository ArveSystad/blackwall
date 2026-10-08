import type { Task } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import {
  runStepsQuery,
  stepEventsQuery,
  taskDiffsQuery,
  taskFindingsQuery,
  taskGrillQuery,
  taskRunsQuery,
} from "../../query";
import { checkRuns, currentRound, latestStep, visibleFindings } from "../../task-view";

/**
 * Everything the task view reads besides the task itself: runs and the latest
 * run's steps, grill questions, findings, per-round diffs and the latest
 * Checks step's commands. Each panel reads the slice it needs; the header,
 * banner and tab counts read the rest.
 */
export function useTaskData(task: Task) {
  const isReview = task.mode === "review";
  const runs = useQuery(taskRunsQuery(task.id));
  const latestRun = runs.data?.at(-1);
  const steps = useQuery({
    ...runStepsQuery(task.id, latestRun?.id ?? ""),
    enabled: latestRun !== undefined,
  });
  const questions = useQuery({ ...taskGrillQuery(task.id), enabled: !isReview });
  const findings = useQuery(taskFindingsQuery(task.id));
  const diffs = useQuery({ ...taskDiffsQuery(task.id), enabled: task.worktreePath !== null });

  const stepList = latestRun ? (steps.data ?? []) : [];
  const checksStep = latestStep(stepList, "checks");
  const checkEvents = useQuery({
    ...stepEventsQuery(task.id, checksStep?.id ?? ""),
    enabled: checksStep !== undefined,
  });

  return {
    runs,
    latestRun,
    steps: stepList,
    stepsQuery: steps,
    round: currentRound(stepList),
    questions,
    findings,
    visibleFindings: visibleFindings(findings.data ?? []),
    diffs,
    checksStep,
    checks: checksStep ? checkRuns(checkEvents.data ?? []) : [],
    checksQuery: checkEvents,
  };
}

export type TaskData = ReturnType<typeof useTaskData>;
