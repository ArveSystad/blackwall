import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { reposQuery } from "../query";
import { resolveSelectedRepo, setSelectedRepo, useSelectedRepoId } from "../selected-repo";
import { BacklogIcon, CloseIcon } from "./icons";
import { Button } from "./ui/button";

/** Status bar atop the main pane: the selected repo, a way back to its backlog, and clear. */
export function RepoContextBar() {
  const repos = useQuery(reposQuery);
  const repo = resolveSelectedRepo(useSelectedRepoId(), repos.data);
  return (
    <div
      className="flex h-8 flex-none items-center gap-2 border-b border-border bg-sidebar px-5 text-meta"
      aria-label="Selected repo"
      role="region"
    >
      <span className="label text-muted-foreground">Repo</span>
      {repo ? (
        <>
          <span className="mono font-semibold text-foreground-strong">{repo.name}</span>
          <span className="mono min-w-0 flex-1 truncate text-faint" title={repo.path}>
            {repo.path}
          </span>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/repos/$repoId/backlog" params={{ repoId: repo.id }}>
              <BacklogIcon size="sm" />
              Backlog
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear selected repo"
            onClick={() => setSelectedRepo(null)}
          >
            <CloseIcon size="sm" />
          </Button>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          No repo selected · pick a backlog
        </span>
      )}
    </div>
  );
}
