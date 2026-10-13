import type { Task } from "@blackwall/shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  runStepsQuery,
  stepEventsQuery,
  taskArtifactsQuery,
  taskBranchDiffQuery,
  taskDiffsQuery,
  taskFindingsQuery,
  taskGrillQuery,
  taskRunsQuery,
} from "../../query";
import {
  checkRuns,
  currentRound,
  deliveryConflicts,
  latestHarnessStep,
  latestStep,
  pullRequestUrl,
  visibleFindings,
} from "../../task-view";

/**
 * Everything the task view reads besides the task itself: runs and the latest
 * run's steps, grill questions, findings, per-round and whole-branch diffs,
 * the artifacts, the latest Checks step's commands, the rebase conflicts of
 * the latest delivery and the pull request any delivery attempt at the task's
 * stage opened. Each panel reads the slice it needs; the header, banner and
 * tab counts read the rest.
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
  const branchDiff = useQuery({
    ...taskBranchDiffQuery(task.id),
    enabled: task.worktreePath !== null,
  });
  const artifacts = useQuery({
    ...taskArtifactsQuery(task.id),
    enabled: !isReview && task.worktreePath !== null,
  });

  const stepList = latestRun ? (steps.data ?? []) : [];
  const checksStep = latestStep(stepList, "checks");
  const checkEvents = useQuery({
    ...stepEventsQuery(task.id, checksStep?.id ?? ""),
    enabled: checksStep !== undefined,
  });
  const deliveryStep = latestHarnessStep(stepList, task.stage ?? "summarize");
  const deliveryEvents = useQuery({
    ...stepEventsQuery(task.id, deliveryStep?.id ?? ""),
    enabled: deliveryStep !== undefined,
  });
  // A retried delivery skips what already went out, so the PR may sit in an earlier attempt.
  const deliverySteps = stepList.filter(
    (s) => s.agentId === null && s.stage === (task.stage ?? "summarize"),
  );
  const allDeliveryEvents = useQueries({
    queries: deliverySteps.map((s) => stepEventsQuery(task.id, s.id)),
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
    branchDiff,
    artifacts,
    checksStep,
    checks: checksStep ? checkRuns(checkEvents.data ?? []) : [],
    checksQuery: checkEvents,
    deliveryStep,
    deliveryConflicts: deliveryStep ? deliveryConflicts(deliveryEvents.data ?? []) : [],
    pullRequestUrl: pullRequestUrl(allDeliveryEvents.flatMap((q) => q.data ?? [])),
  };
}

export type TaskData = ReturnType<typeof useTaskData>;
