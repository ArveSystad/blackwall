import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { pendingCount, repoStatusLine } from "../backlog";
import { backlogQuery, backlogRunnerQuery, reposQuery, settingsQuery, tasksQuery } from "../query";
import { resolveSelectedRepo, setSelectedRepo, useSelectedRepoId } from "../selected-repo";
import { BacklogIcon } from "./icons";
import { Button } from "./ui/button";
import { Select } from "./ui/select";

/**
 * Status bar atop the main pane: pick the repo to work in (each with how many items wait in its
 * backlog), see how many of its tasks run and whether auto-start is on, and go back to its backlog.
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
    if (!id) {
      setSelectedRepo(null);
      return;
    }
    setSelectedRepo(id);
    void navigate({ to: "/repos/$repoId/backlog", params: { repoId: id } });
  };

  return (
    <div
      className="flex h-11 flex-none items-center gap-3 border-b border-border bg-sidebar px-5 text-meta"
      aria-label="Repo context"
      role="region"
    >
      <span className="label text-muted-foreground">Repo</span>
      <Select
        aria-label="Selected repo"
        className="mono h-7 w-auto max-w-[260px] shrink-0"
        value={repo?.id ?? ""}
        onChange={(e) => pick(e.target.value)}
      >
        <option value="">No repo</option>
        {usable.map((r, i) => {
          const items = backlogs[i]?.data;
          return (
            <option key={r.id} value={r.id}>
              {items ? `${r.name} · ${pendingCount(items)} waiting` : r.name}
            </option>
          );
        })}
      </Select>
      {repo ? (
        <>
          {status && (
            <span className="shrink-0 whitespace-nowrap text-muted-foreground">{status}</span>
          )}
          <span className="mono min-w-0 flex-1 truncate text-faint" title={repo.path}>
            {repo.path}
          </span>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/repos/$repoId/backlog" params={{ repoId: repo.id }}>
              <BacklogIcon size="sm" />
              Backlog
            </Link>
          </Button>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          Pick a repo to work in
        </span>
      )}
    </div>
  );
}
