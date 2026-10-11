import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { pendingCount, repoStatusLine } from "../backlog";
import { backlogQuery, backlogRunnerQuery, reposQuery, settingsQuery, tasksQuery } from "../query";
import { resolveSelectedRepo, setSelectedRepo, useSelectedRepoId } from "../selected-repo";
import { BacklogIcon } from "./icons";
import { RepoMenuItems } from "./RepoMenuItems";
import { Button } from "./ui/button";
import {
  SelectMenu,
  SelectMenuContent,
  SelectMenuItem,
  SelectMenuSeparator,
  SelectMenuTrigger,
} from "./ui/select-menu";

/** Item value for "No repo": Radix Select forbids an empty one, and repo ids are UUIDs. */
const NO_REPO = "none";

/**
 * Status bar atop the main pane: pick the repo to work in (each with how many items wait in its
 * backlog), jump to its backlog, and see how many of its tasks run and whether auto-start is on.
 */
export function RepoContextBar() {
  const navigate = useNavigate();
  const repos = useQuery(reposQuery);
  const usable = (repos.data ?? []).filter((r) => r.exists);
  const backlogs = useQueries({ queries: usable.map((r) => backlogQuery(r.id)) });
  const repo = resolveSelectedRepo(useSelectedRepoId(), repos.data);
  const tasks = useQuery(tasksQuery);
  const settings = useQuery(settingsQuery);
  const runner = useQuery({ ...backlogRunnerQuery(repo?.id ?? ""), enabled: !!repo });

  const repoTasks = repo ? (tasks.data ?? []).filter((t) => t.repoId === repo.id) : [];
  const status =
    repo && tasks.data && settings.data && runner.data
      ? repoStatusLine({ settings: settings.data, runner: runner.data, tasks: repoTasks })
      : null;

  const pick = (id: string) => {
    if (id === NO_REPO) {
      setSelectedRepo(null);
      return;
    }
    setSelectedRepo(id);
    void navigate({ to: "/repos/$repoId/backlog", params: { repoId: id } });
  };

  return (
    <div
      className="flex h-11 flex-none items-center gap-3 border-b border-border bg-sidebar px-5 text-body"
      aria-label="Repo context"
      role="region"
    >
      <span className="label text-foreground">Repo</span>
      <SelectMenu value={repo?.id ?? NO_REPO} onValueChange={pick}>
        <SelectMenuTrigger
          aria-label="Selected repo"
          className="mono h-7 w-auto max-w-[260px] shrink-0 text-[12.5px]"
        />
        <SelectMenuContent>
          <SelectMenuItem value={NO_REPO}>No repo</SelectMenuItem>
          {usable.length > 0 && <SelectMenuSeparator />}
          <RepoMenuItems
            repos={usable}
            trailing={(r) => {
              const items = backlogs[usable.indexOf(r)]?.data;
              return (
                items && <span className="mono text-faint">{pendingCount(items)} waiting</span>
              );
            }}
          />
        </SelectMenuContent>
      </SelectMenu>
      {repo ? (
        <>
          <Button variant="ghost" size="sm" className="shrink-0" asChild>
            <Link to="/repos/$repoId/backlog" params={{ repoId: repo.id }}>
              <BacklogIcon size="sm" />
              View backlog
            </Link>
          </Button>
          {status && <span className="shrink-0 whitespace-nowrap text-foreground">{status}</span>}
          <span
            className="mono min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground"
            title={repo.path}
          >
            {repo.path}
          </span>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate text-foreground">Pick a repo to work in</span>
      )}
    </div>
  );
}
