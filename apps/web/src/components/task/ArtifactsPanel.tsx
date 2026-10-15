import type { Task, TaskArtifact } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { artifactUrl } from "../../api";
import { useNow } from "../../hooks";
import { relativeTime } from "../../inbox";
import { taskArtifactsQuery } from "../../query";
import { panelNote } from "../classes";

function ArtifactCard({
  taskId,
  artifact,
  now,
}: {
  taskId: string;
  artifact: TaskArtifact;
  now: Date;
}) {
  const [failed, setFailed] = useState(false);
  const { path, modifiedAt } = artifact;
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-card">
      <a
        href={artifactUrl(taskId, artifact)}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${path} in a new tab`}
        className="flex h-44 items-center justify-center border-b border-border bg-code focus-visible:shadow-ring focus-visible:outline-none"
      >
        {failed ? (
          <span className="px-3 text-center text-meta text-muted-foreground">
            Couldn&apos;t load this image.
          </span>
        ) : (
          <img
            src={artifactUrl(taskId, artifact)}
            alt=""
            loading="lazy"
            className="max-h-full max-w-full object-contain"
            onError={() => setFailed(true)}
          />
        )}
      </a>
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <span
          className="mono min-w-0 flex-1 truncate text-meta text-foreground-strong"
          title={path}
        >
          {path}
        </span>
        <time
          className="shrink-0 text-label text-faint"
          dateTime={modifiedAt.toISOString()}
          title={modifiedAt.toLocaleString()}
        >
          {relativeTime(modifiedAt, now)}
        </time>
      </div>
    </div>
  );
}

/**
 * Images the implementer saved to `.blackwall/artifacts/` in the worktree.
 * Refetched on opening the tab and every 5 s while the task runs, since
 * screenshots land mid-step.
 */
export function ArtifactsPanel({ task }: { task: Task }) {
  const artifacts = useQuery({
    ...taskArtifactsQuery(task.id),
    refetchOnMount: "always",
    refetchInterval: task.status === "running" ? 5_000 : false,
  });
  const now = useNow();
  if (artifacts.isPending) return <p className={panelNote}>Collecting artifacts…</p>;
  const list = artifacts.data ?? [];
  if (list.length === 0) {
    return (
      <p className={panelNote}>
        Nothing captured yet. Implementers can save screenshots to{" "}
        <code className="mono">.blackwall/artifacts/</code> in the worktree. They appear here while
        the implementer works and are never committed.
      </p>
    );
  }
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(240px,1fr))] content-start gap-4 overflow-auto px-5 py-4">
      {list.map((artifact) => (
        <ArtifactCard
          key={`${artifact.path}:${artifact.modifiedAt.getTime()}`}
          taskId={task.id}
          artifact={artifact}
          now={now}
        />
      ))}
    </div>
  );
}
