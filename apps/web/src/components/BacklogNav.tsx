import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { pendingCount } from "../backlog";
import { backlogQuery, reposQuery } from "../query";
import { BacklogIcon } from "./icons";

/** Inbox section linking each repo's backlog, with how many items wait in it. */
export function BacklogNav() {
  const repos = useQuery(reposQuery);
  const usable = (repos.data ?? []).filter((r) => r.exists);
  const backlogs = useQueries({ queries: usable.map((r) => backlogQuery(r.id)) });
  if (usable.length === 0) return null;
  return (
    <nav
      aria-label="Backlogs"
      className="flex max-h-[30%] shrink-0 flex-col gap-0.5 overflow-y-auto border-t border-border p-2"
    >
      <h2 className="m-0 flex items-center gap-2 px-1.5 pt-1 pb-1 pl-2">
        <span className="label text-muted-foreground">Backlog</span>
        <span className="h-px flex-1 bg-border" />
      </h2>
      {usable.map((repo, i) => {
        const items = backlogs[i]?.data;
        const count = items ? pendingCount(items) : null;
        return (
          <Link
            key={repo.id}
            to="/repos/$repoId/backlog"
            params={{ repoId: repo.id }}
            className="flex h-7 items-center gap-2 rounded-md border border-transparent px-2 text-meta text-foreground no-underline hover:bg-card hover:no-underline focus-visible:shadow-ring focus-visible:outline-none data-[status=active]:border-border-strong data-[status=active]:bg-muted data-[status=active]:text-foreground-strong"
          >
            <BacklogIcon size="sm" className="text-muted-foreground" />
            <span className="mono min-w-0 flex-1 truncate">{repo.name}</span>
            {count !== null && (
              <span
                className={
                  count > 0 ? "mono text-label text-muted-foreground" : "mono text-label text-faint"
                }
              >
                {count}
                <span className="sr-only"> waiting</span>
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
