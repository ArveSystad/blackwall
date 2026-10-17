import { MAX_ARTIFACT_BYTES, type Task, type TaskArtifact } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { artifactUrl } from "../../api";
import { useNow } from "../../hooks";
import { relativeTime } from "../../inbox";
import { taskArtifactTextQuery, taskArtifactsQuery } from "../../query";
import { formatBytes } from "../../system-info";
import { panelNote } from "../classes";
import { Markdown } from "../Markdown";

/** Largest text artifact previewed in its card; bigger ones get the plain file card. */
const TEXT_PREVIEW_BYTES = 256 * 1024;

const previewNote = "px-3 text-center text-meta text-muted-foreground";

/** The file's extension in capitals, e.g. `ZIP`, or `FILE` without one. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : "FILE";
}

function ImagePreview({ taskId, artifact }: { taskId: string; artifact: TaskArtifact }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className={previewNote}>Couldn&apos;t load this image.</span>;
  return (
    <img
      src={artifactUrl(taskId, artifact)}
      alt=""
      loading="lazy"
      className="max-h-full max-w-full object-contain"
      onError={() => setFailed(true)}
    />
  );
}

/** The top of a text artifact: Markdown rendered, anything else as source. */
function TextPreview({ taskId, artifact }: { taskId: string; artifact: TaskArtifact }) {
  const text = useQuery(taskArtifactTextQuery(taskId, artifact));
  if (text.isError) return <span className={previewNote}>Couldn&apos;t load this file.</span>;
  if (text.isPending) return <span className={previewNote}>Loading…</span>;
  return /\.(md|markdown)$/i.test(artifact.path) ? (
    <Markdown className="h-full w-full overflow-hidden px-3 py-2 text-meta">{text.data}</Markdown>
  ) : (
    <pre className="mono m-0 h-full w-full overflow-hidden px-3 py-2 text-meta whitespace-pre text-foreground">
      {text.data}
    </pre>
  );
}

function FilePreview({ artifact }: { artifact: TaskArtifact }) {
  return (
    <span className="flex flex-col items-center gap-1">
      <span className="mono border border-border px-2 py-1 text-meta font-semibold text-foreground-strong">
        {extensionOf(artifact.path)}
      </span>
      <span className="text-label text-faint">{formatBytes(artifact.size)}</span>
    </span>
  );
}

function ArtifactCard({
  taskId,
  artifact,
  now,
}: {
  taskId: string;
  artifact: TaskArtifact;
  now: Date;
}) {
  const { path, modifiedAt, size, kind } = artifact;
  const tooLarge = size > MAX_ARTIFACT_BYTES;
  const textPreview = kind === "text" && size <= TEXT_PREVIEW_BYTES;
  return (
    <div className="bw-chamfer flex min-w-0 flex-col overflow-hidden bg-card [--bw-chamfer-line:var(--border)]">
      <div
        className={`relative flex h-44 justify-center overflow-hidden border-b border-border bg-code ${
          textPreview && !tooLarge ? "items-start" : "items-center"
        }`}
      >
        {tooLarge ? (
          <span className={previewNote}>Too large to open</span>
        ) : (
          <>
            {kind === "image" ? (
              <ImagePreview taskId={taskId} artifact={artifact} />
            ) : textPreview ? (
              <TextPreview taskId={taskId} artifact={artifact} />
            ) : (
              <FilePreview artifact={artifact} />
            )}
            {/* Over the preview rather than around it, so Markdown links don't nest in it. */}
            <a
              href={artifactUrl(taskId, artifact)}
              target="_blank"
              rel="noreferrer"
              {...(kind === "file" ? { download: path.slice(path.lastIndexOf("/") + 1) } : {})}
              aria-label={kind === "file" ? `Download ${path}` : `Open ${path} in a new tab`}
              className="absolute inset-0 focus-visible:shadow-ring focus-visible:outline-none"
            />
          </>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <span
          className="mono min-w-0 flex-1 truncate text-meta text-foreground-strong"
          title={path}
        >
          {path}
        </span>
        <span className="shrink-0 text-label text-faint">{formatBytes(size)}</span>
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
 * Files the implementer saved to `.blackwall/artifacts/` in the worktree:
 * images preview, text shows its top (Markdown rendered), and other files
 * download. Refetched on opening the tab and every 5 s while the task runs,
 * since files land mid-step.
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
        Nothing captured yet. Implementers can save files (screenshots, notes, logs, archives…) to{" "}
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
