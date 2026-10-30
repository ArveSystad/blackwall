import type { RepoView } from "@blackwall/shared";
import { useState } from "react";
import { cn } from "../lib/utils";
import { TerminalIcon } from "./icons";
import { ProjectOutputModal } from "./ProjectOutputModal";
import { PROJECT_GLOWING, ProjectRunAction } from "./ProjectRunAction";
import { Button } from "./ui/button";
import { useProjectRun } from "./use-project-run";

/**
 * Run project, next to View backlog: starts the repo's run commands. Once a run
 * exists it splits in two: start/stop on the left, glowing green while the
 * project runs, and its output window on the right. Disabled, with the reason
 * as its title, while the repo has no run commands or folder.
 */
export function RunProjectButton({ repo, className }: { repo: RepoView; className?: string }) {
  const project = useProjectRun(repo);
  const [outputOpen, setOutputOpen] = useState(false);
  const { state } = project;
  return (
    <span className={cn("inline-flex items-center gap-px", className)}>
      <ProjectRunAction project={project} />
      {state.showOutputButton && (
        <Button
          variant="primary"
          size="icon"
          className={cn(state.glowing && PROJECT_GLOWING)}
          aria-label="Show output"
          title="Show output"
          onClick={() => setOutputOpen(true)}
        >
          <TerminalIcon size="sm" />
        </Button>
      )}
      {outputOpen && (
        <ProjectOutputModal repo={repo} project={project} onClose={() => setOutputOpen(false)} />
      )}
    </span>
  );
}
