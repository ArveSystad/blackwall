import type { RepoView } from "@blackwall/shared";
import { useState } from "react";
import { cn } from "../lib/utils";
import { TerminalIcon } from "./icons";
import { ProjectOutputModal } from "./ProjectOutputModal";
import { PROJECT_GLOWING, ProjectRunAction } from "./ProjectRunAction";
import { Button } from "./ui/button";
import { useProjectRun } from "./use-project-run";

/**
 * Run project, next to View backlog: starts the repo's run commands. One
 * chamfered button group: once a run exists, its output half slides out from
 * behind the start/stop half, which glows green while the project runs.
 * Disabled, with the reason as its title, while the repo has no run commands or
 * folder.
 */
export function RunProjectButton({ repo, className }: { repo: RepoView; className?: string }) {
  const project = useProjectRun(repo);
  const [outputOpen, setOutputOpen] = useState(false);
  const { state, loaded } = project;
  // Slide only when the output button appears while watching, not when a run is already there on
  // load. TopBar keys this on the repo, so a repo switch starts unarmed too.
  const [armed, setArmed] = useState(false);
  if (loaded && !state.showOutputButton && !armed) setArmed(true);
  return (
    <span className={cn("inline-flex", className)}>
      <span className="isolate inline-flex items-center gap-px">
        <ProjectRunAction project={project} className="bw-chamfer-seg relative z-10" />
        {state.showOutputButton && (
          <Button
            variant="primary"
            size="icon"
            className={cn(
              "bw-chamfer-seg",
              armed && "animate-slide-out",
              state.glowing && PROJECT_GLOWING,
            )}
            aria-label="Show output"
            title="Show output"
            onClick={() => setOutputOpen(true)}
          >
            <TerminalIcon size="sm" />
          </Button>
        )}
      </span>
      {outputOpen && (
        <ProjectOutputModal repo={repo} project={project} onClose={() => setOutputOpen(false)} />
      )}
    </span>
  );
}
