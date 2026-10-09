import type { GateDecision, GateResponseInput, Task } from "@blackwall/shared";
import { archiveTask, respondToGate, resumeTask, stopTask, unarchiveTask } from "../../api";
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

export function resume(action: TaskAction, task: Task) {
  return action.run("Resume", () => resumeTask(task.id));
}

/** Stops a queued or running task; Resume continues it later. */
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

/** Puts the cursor in the input bar, where change requests and instructions are typed. */
export function focusInputBar(): void {
  document.getElementById("task-input-bar")?.focus();
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
 * mid-step, so there is nowhere to send it while the task runs.
 */
export function messageRoute(task: Pick<Task, "status" | "gate" | "mode">): MessageRoute | null {
  if (task.status !== "needs-you" || task.mode === "review") return null;
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
