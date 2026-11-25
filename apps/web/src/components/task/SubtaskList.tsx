import type { Task } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { statusLabel } from "../../inbox";
import { reposQuery, tasksQuery } from "../../query";
import { childrenOf } from "../../subtasks";
import { ChevronRightIcon } from "../icons";
import { Markdown } from "../Markdown";
import { StatusBadge } from "../StatusBadge";

/** Repo names by id, from the repo list; the id itself until it loads or when the repo is gone. */
function useRepoName(): (id: string) => string {
  const repos = useQuery(reposQuery);
  return (id) => repos.data?.find((repo) => repo.id === id)?.name ?? id;
}

/**
 * The subtasks a plan proposes, before approval starts them: repo, title, and
 * the description (that repo's part of the plan) folded under each.
 */
export function ProposedSubtasks({ task }: { task: Pick<Task, "subtasks"> }) {
  const repoName = useRepoName();
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Proposed subtasks">
      {task.subtasks.map((subtask) => (
        <li key={subtask.repoId}>
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-meta text-foreground-strong">
              <ChevronRightIcon size="sm" className="text-faint group-open:rotate-90" />
              <span className="mono text-label text-muted-foreground">
                {repoName(subtask.repoId)}
              </span>
              <span className="truncate">{subtask.title}</span>
            </summary>
            <Markdown className="mt-1 ml-5 max-w-3xl text-meta">{subtask.description}</Markdown>
          </details>
        </li>
      ))}
    </ul>
  );
}

/** The tasks a split task started, each with its repo, a link and its status. */
export function StartedSubtasks({ task }: { task: Pick<Task, "id"> }) {
  const tasks = useQuery(tasksQuery);
  const repoName = useRepoName();
  const children = childrenOf(tasks.data ?? [], task.id);
  if (children.length === 0) {
    return <p className="m-0 text-meta text-muted-foreground">No subtasks left.</p>;
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Subtasks">
      {children.map((child) => (
        <li key={child.id} className="flex min-w-0 items-center gap-2 text-meta">
          <span className="mono text-label text-muted-foreground">{repoName(child.repoId)}</span>
          <Link
            to="/tasks/$taskId"
            params={{ taskId: child.id }}
            className="min-w-0 truncate text-foreground-strong"
          >
            {child.title}
          </Link>
          <span className="flex-1" />
          <StatusBadge status={child.status} label={statusLabel(child)} />
        </li>
      ))}
    </ul>
  );
}
