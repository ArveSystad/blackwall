import type { TaskDiff } from "@blackwall/shared";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { diffStat, parseDiff, type DiffFile } from "../../task-view";
import { panelNote } from "../classes";
import { DiffView } from "../DiffView";
import { ChevronRightIcon } from "../icons";
import { Segmented } from "../Segmented";

function roundLabel(diff: TaskDiff): string {
  if (!diff.reviewed) return "Not reviewed yet";
  return diff.round === 0 ? "Implementation" : `Fix round ${diff.round}`;
}

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="mono inline-flex gap-1.5 text-[11px]">
      <span className="text-diff-add-fg">+{additions}</span>
      <span className="text-diff-del-fg">−{deletions}</span>
    </span>
  );
}

function FileDiff({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 cursor-pointer items-center gap-2 bg-transparent text-left"
      >
        <ChevronRightIcon size="sm" className={cn("text-faint", open && "rotate-90")} />
        <span className="mono truncate text-foreground-strong">{file.path}</span>
        <DiffStat additions={file.additions} deletions={file.deletions} />
      </button>
      {open &&
        (file.lines.length === 0 ? (
          <p className="m-0 pl-5 text-meta text-muted-foreground">Binary file or mode change.</p>
        ) : (
          <DiffView lines={file.lines} />
        ))}
    </section>
  );
}

/** The task branch's changes per fix round, file by file (plain diff colors, never neon). */
export function DiffPanel({ diffs, loading }: { diffs: readonly TaskDiff[]; loading: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  if (loading) return <p className={panelNote}>Loading the diff…</p>;
  if (diffs.length === 0) {
    return (
      <p className={panelNote}>
        No changes on the branch yet. The implementer commits in the Implement stage.
      </p>
    );
  }

  const keys = diffs.map((d) => `${d.round}:${d.reviewed}`);
  const key = selected && keys.includes(selected) ? selected : keys.at(-1)!;
  const diff = diffs[keys.indexOf(key)]!;
  const files = parseDiff(diff.diff);
  const stat = diffStat(files);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-2.5">
        {diffs.length > 1 && (
          <Segmented
            label="Review round"
            value={key}
            onChange={setSelected}
            options={diffs.map((d, i) => ({ value: keys[i]!, label: roundLabel(d) }))}
          />
        )}
        <span className="text-meta text-muted-foreground">
          {roundLabel(diff)} · {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        <DiffStat {...stat} />
        <span className="flex-1" />
        <span className="mono text-[11px] text-faint">
          {diff.from.slice(0, 7)}…{diff.to.slice(0, 7)}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
        {files.length === 0 ? (
          <p className="m-0 text-muted-foreground">This round changed no files.</p>
        ) : (
          files.map((file) => <FileDiff key={file.path} file={file} />)
        )}
      </div>
    </div>
  );
}
