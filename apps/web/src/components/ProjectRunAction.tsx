import { cn } from "../lib/utils";
import { PlayIcon, StopIcon } from "./icons";
import { Button } from "./ui/button";
import type { ProjectRunControl } from "./use-project-run";

/** The project is up: the purple fill turns green and glows. */
export const PROJECT_GLOWING = "[--bw-chamfer-bg:var(--st-done)] drop-shadow-glow-done";

/** Run or stop the project, labelled for its run's state. */
export function ProjectRunAction({
  project,
  className,
}: {
  project: ProjectRunControl;
  className?: string;
}) {
  const { state, pending, error, act } = project;
  return (
    <Button
      variant="primary"
      className={cn(state.glowing && PROJECT_GLOWING, className)}
      disabled={state.disabled || pending}
      title={error ?? state.title}
      onClick={() => void act()}
    >
      {state.mainAction === "stop" ? <StopIcon size="sm" /> : <PlayIcon size="sm" />}
      {state.mainLabel}
    </Button>
  );
}
