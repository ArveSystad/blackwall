import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../api";
import { BranchIcon, RepoIcon, WallIcon } from "../components/icons";
import { StageStepper } from "../components/StageStepper";
import { StatusBadge } from "../components/StatusBadge";
import { originKey } from "../inbox";
import { reposQuery, taskQuery } from "../query";

const MODE_LABELS = { work: "Work on PR", review: "Review PR" } as const;

function Centered({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <WallIcon className="size-7 text-faint" />
      <span className="font-medium text-foreground-strong">{title}</span>
      {detail && <span className="text-meta text-muted-foreground">{detail}</span>}
    </div>
  );
}

/** Main pane for one task: its header and stage progress. */
export function TaskView({ taskId }: { taskId: string }) {
  const task = useQuery(taskQuery(taskId));
  const repos = useQuery(reposQuery);

  if (task.isPending) return <Centered title="Loading task…" />;
  if (task.isError) {
    return task.error instanceof ApiError && task.error.status === 404 ? (
      <Centered title="Task not found" detail="It may have been deleted." />
    ) : (
      <Centered title="Could not load the task" detail={task.error.message} />
    );
  }

  const { data } = task;
  const repo = repos.data?.find((r) => r.id === data.repoId);
  const origin = data.origin;
  const kindLabel =
    origin.kind === "jira-issue"
      ? "Jira"
      : origin.kind === "github-pr"
        ? data.mode
          ? MODE_LABELS[data.mode]
          : "Pull request"
        : "Free text";

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex flex-col gap-2 border-b border-border bg-sidebar px-5 pt-3.5 pb-3">
        <div className="flex items-center gap-2 text-meta">
          {origin.kind === "github-pr" ? (
            <a className="mono" href={origin.url} target="_blank" rel="noreferrer">
              {originKey(data)}
            </a>
          ) : (
            <span className="mono text-muted-foreground">{originKey(data)}</span>
          )}
          <span className="inline-flex h-5 items-center rounded-sm border border-border-strong px-1.5 text-[11.5px] font-medium text-muted-foreground">
            {kindLabel}
          </span>
          <span className="flex-1" />
          <StatusBadge status={data.status} />
        </div>
        <h1 className="m-0 text-title font-semibold tracking-[-0.01em] text-foreground-strong">
          {data.title}
        </h1>
        <div className="flex flex-wrap items-center gap-3.5 text-meta text-muted-foreground">
          {repo && (
            <span className="inline-flex items-center gap-[5px]">
              <RepoIcon size="sm" />
              <span className="mono">{repo.name}</span>
            </span>
          )}
          {data.branch && (
            <span className="inline-flex items-center gap-[5px]">
              <BranchIcon size="sm" />
              <span className="mono text-foreground">{data.branch}</span>
            </span>
          )}
        </div>
        <div className="mt-1">
          <StageStepper task={data} />
        </div>
      </header>
      <div className="flex-1 overflow-auto px-5 py-4">
        {data.freeText ? (
          <section className="flex max-w-3xl flex-col gap-1.5">
            <h2 className="label m-0 text-muted-foreground">Context</h2>
            <p className="m-0 whitespace-pre-wrap">{data.freeText}</p>
          </section>
        ) : (
          <p className="m-0 text-muted-foreground">No context added for this task.</p>
        )}
      </div>
    </div>
  );
}
