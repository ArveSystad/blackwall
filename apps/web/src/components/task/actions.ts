import type { GateDecision, GateResponseInput, Task } from "@blackwall/shared";
import {
  archiveTask,
  fixCi as fixCiRequest,
  fixPrComments as fixPrCommentsRequest,
  respondToGate,
  resumeTask,
  stopTask,
  unarchiveTask,
} from "../../api";
import type { TaskAction } from "./use-task-action";

/** Answers the task's gate; `message` rides along as instructions for the next stage. */
export function answerGate(
  action: TaskAction,
  task: Task,
  input: Omit<GateResponseInput, "gate">,
  label: string,
) {
  if (!task.gate) return Promise.resolve(undefined);
  const gate = task.gate;
  return action.run(label, () => respondToGate(task.id, { gate, ...input }));
}

/** The optional comment on a GitHub issue task's issue when its plan is approved. */
export interface PlanComment {
  /** Unticked by default: nothing is posted unless the user opts in. */
  enabled: boolean;
  body: string;
}

/** Approves the plan, posting the plan comment first when the user ticked it. */
export function approvePlan(action: TaskAction, task: Task, comment: PlanComment) {
  const body = comment.body.trim();
  const post = comment.enabled && body && task.origin.kind === "github-issue";
  return answerGate(
    action,
    task,
    { decision: "approve", ...(post ? { issueComment: { body } } : {}) },
    "Approve plan",
  );
}

/** Resumes an interrupted or failed task; `message` is guidance for the steps that failed or stopped. */
export function resume(action: TaskAction, task: Task, message?: string) {
  return action.run("Resume", () => resumeTask(task.id, message));
}

/** Stops a queued, running or waiting task; Resume continues it later. */
export function stop(action: TaskAction, task: Task) {
  return action.run("Stop", () => stopTask(task.id));
}

/** Moves a done task to the repo's archive, out of the inbox. */
export function archive(action: TaskAction, task: Task) {
  return action.run("Archive", () => archiveTask(task.id));
}

/** Brings an archived task back to the inbox. */
export function unarchive(action: TaskAction, task: Task) {
  return action.run("Unarchive", () => unarchiveTask(task.id));
}

/** Runs a fix round on the task's failed CI; the task stops at Finish to push again. */
export function fixCi(action: TaskAction, task: Task) {
  return action.run("Fix CI", () => fixCiRequest(task.id));
}

/** Runs a fix round on the new comments on the task's pull request; it stops at Finish to push again. */
export function fixPrComments(action: TaskAction, task: Task) {
  return action.run("Fetch comments and fix", () => fixPrCommentsRequest(task.id));
}

export interface MessageRoute {
  /** Who reads the message. */
  to: string;
  decision: GateDecision;
  /** What sending does. */
  send: string;
  placeholder: string;
}

/**
 * Where a typed instruction goes: it rides on the answer to the gate the task
 * waits on, as the next stage's instructions. Agents are not interrupted
 * mid-step, so there is nowhere to send it while the task runs. A Review PR
 * task takes one only at triage, where it sends the reviewers back over the PR.
 */
export function messageRoute(task: Pick<Task, "status" | "gate" | "mode">): MessageRoute | null {
  if (task.status !== "needs-you") return null;
  if (task.mode === "review") {
    if (task.gate !== "triage") return null;
    return {
      to: "reviewers",
      decision: "revise",
      send: "Review again",
      placeholder: "Ask the reviewers to look again, with this instruction…",
    };
  }
  switch (task.gate) {
    case "plan-approval":
      return {
        to: "planner",
        decision: "revise",
        send: "Request changes",
        placeholder: "What should change in the plan? The planner re-plans with this.",
      };
    case "triage":
      return {
        to: "implementer",
        decision: "approve",
        send: "Start fix round",
        placeholder: "Add an instruction or context for the next fix round…",
      };
    case "escalation":
    case "finish":
      return {
        to: "implementer",
        decision: "revise",
        send: "Send back",
        placeholder: "Send the work back for one more fix round with this instruction…",
      };
    default:
      return null;
  }
}
