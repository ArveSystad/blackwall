import {
  MAX_PROJECT_OUTPUT_CHARS,
  type ProjectRun,
  type ProjectRunOutput,
  type RepoView,
} from "@blackwall/shared";

/** What the Run project split button shows for a repo and its latest run. */
export interface RunButtonState {
  /** The main half can't be clicked; `title` says why. */
  disabled: boolean;
  title: string;
  mainLabel: string;
  mainAction: "start" | "stop";
  /** The project is up: the main half glows green. */
  glowing: boolean;
  /** A run exists, so its output can be read. */
  showOutputButton: boolean;
}

/** True while the repo's run has processes that are, or may still be, alive. */
export function isRunActive(run: ProjectRun | undefined): boolean {
  return run?.status === "starting" || run?.status === "running" || run?.status === "stopping";
}

export function runButtonState(repo: RepoView, run: ProjectRun | undefined): RunButtonState {
  const showOutputButton = run !== undefined;
  const start = { mainLabel: "Run project", mainAction: "start" as const, glowing: false };
  if (run?.status === "starting" || run?.status === "running") {
    return {
      disabled: false,
      title: run.status === "running" ? "The project is running" : "The project is starting",
      mainLabel: "Stop project",
      mainAction: "stop",
      glowing: run.status === "running",
      showOutputButton,
    };
  }
  if (run?.status === "stopping") {
    return {
      disabled: true,
      title: "Stopping the project",
      mainLabel: "Stopping…",
      mainAction: "stop",
      glowing: false,
      showOutputButton,
    };
  }
  if (repo.runCommands.length === 0) {
    return {
      ...start,
      disabled: true,
      title: "Add run commands in Settings → Repositories to run this project from here",
      showOutputButton,
    };
  }
  if (!repo.exists) {
    return { ...start, disabled: true, title: "The repo folder is missing", showOutputButton };
  }
  return {
    ...start,
    disabled: false,
    title: run?.status === "failed" && run.error ? run.error : "Start the repo's run commands",
    showOutputButton,
  };
}

/**
 * The cached output with a `projectRun.output` chunk appended, capped to the
 * last {@link MAX_PROJECT_OUTPUT_CHARS} characters; null when the chunk is from
 * another run or doesn't follow on from the cache, so it must be refetched.
 */
export function appendProjectOutput(
  cached: ProjectRunOutput | null,
  event: { runId: string; end: number; text: string },
): ProjectRunOutput | null {
  if (!cached || cached.runId !== event.runId) return null;
  if (cached.end !== event.end - event.text.length) return null;
  return {
    runId: cached.runId,
    end: event.end,
    text: (cached.text + event.text).slice(-MAX_PROJECT_OUTPUT_CHARS),
  };
}
