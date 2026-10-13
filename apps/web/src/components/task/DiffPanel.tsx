import type { BranchDiff, DiffCommentInput, Task, TaskDiff } from "@blackwall/shared";
import { useState } from "react";
import {
  isModKey,
  isPlainKey,
  isTypingTarget,
  modKeyLabel,
  useWindowKeydown,
} from "../../keyboard";
import { cn } from "../../lib/utils";
import {
  canCommentOnDiff,
  diffCommentsRunFixRound,
  diffStat,
  parseDiff,
  splitHunks,
  type DiffFile,
  type DiffHunk,
} from "../../task-view";
import { panelNote } from "../classes";
import { DiffView } from "../DiffView";
import { ChevronRightIcon } from "../icons";
import { Segmented } from "../Segmented";
import { Button } from "../ui/button";
import { ErrorText, fieldLabel } from "../ui/field";
import { Kbd } from "../ui/kbd";
import { Textarea } from "../ui/textarea";
import type { TaskAction } from "./use-task-action";

/** Unsent hunk comments, keyed by {@link draftKey}. */
export type DiffDrafts = Record<string, string>;

const draftKey = (hunk: Pick<DiffHunk, "path" | "index">) => `${hunk.path}#${hunk.index}`;

/** The drafts with text, as comments on their hunks; drafts for hunks gone from the diff are dropped. */
function draftComments(hunks: readonly DiffHunk[], drafts: DiffDrafts): DiffCommentInput[] {
  return hunks.flatMap((hunk) => {
    const body = drafts[draftKey(hunk)]?.trim();
    if (!body) return [];
    const { path: file, lineStart, lineEnd, text } = hunk;
    return [{ file, lineStart, lineEnd, hunk: text, body }];
  });
}

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

/**
 * One hunk of the branch diff at a time, with a comment box. ←/→ step through
 * the hunks; the drafts are sent together as findings: force-fixed for the
 * implementer, or in a review task, open to post to the pull request.
 */
function HunkStepper({
  task,
  hunks,
  drafts,
  onDraftsChange,
  onSend,
  action,
}: {
  task: Task;
  hunks: readonly DiffHunk[];
  drafts: DiffDrafts;
  onDraftsChange: (drafts: DiffDrafts) => void;
  onSend: (comments: DiffCommentInput[]) => void;
  action: TaskAction;
}) {
  const [position, setPosition] = useState(0);
  const at = Math.min(position, hunks.length - 1);
  const hunk = hunks[at]!;
  const key = draftKey(hunk);
  const paths = [...new Set(hunks.map((h) => h.path))];
  const inFile = hunks.filter((h) => h.path === hunk.path).length;
  const comments = draftComments(hunks, drafts);
  const canSend = comments.length > 0 && !action.pending;

  const step = (by: number) => setPosition(Math.max(0, Math.min(hunks.length - 1, at + by)));
  useWindowKeydown((event) => {
    // A focused tab trigger already took the arrow (Radix roving focus).
    if (event.defaultPrevented || !isPlainKey(event) || isTypingTarget(event.target)) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      step(event.key === "ArrowRight" ? 1 : -1);
    }
  });

  function send() {
    if (canSend) onSend(comments);
  }

  const review = task.mode === "review";
  const noun = comments.length === 1 ? "comment" : "comments";
  const sendLabel = diffCommentsRunFixRound(task)
    ? `Send ${comments.length} ${noun} and run a fix round`
    : `Send ${comments.length} ${noun}`;
  const id = `hunk-comment-${key}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-5 py-4">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <span className="mono truncate text-foreground-strong">{hunk.path}</span>
        <span className="text-meta text-muted-foreground">
          Hunk {hunk.index + 1} of {inFile} · file {paths.indexOf(hunk.path) + 1} of {paths.length}
        </span>
        <span className="flex-1" />
        <Button size="sm" disabled={at === 0} onClick={() => step(-1)}>
          Previous
          <Kbd aria-hidden="true">←</Kbd>
        </Button>
        <Button size="sm" disabled={at === hunks.length - 1} onClick={() => step(1)}>
          Next
          <Kbd aria-hidden="true">→</Kbd>
        </Button>
      </div>
      <DiffView lines={hunk.lines} />
      <label htmlFor={id} className={fieldLabel}>
        Your comment on this hunk
      </label>
      <Textarea
        id={id}
        rows={3}
        value={drafts[key] ?? ""}
        placeholder={
          review
            ? "What should the PR author know about this hunk?"
            : "What should the implementer change here?"
        }
        onChange={(event) => onDraftsChange({ ...drafts, [key]: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter" && isModKey(event.nativeEvent)) {
            event.preventDefault();
            send();
          } else if (event.key === "Escape") {
            event.currentTarget.blur();
          }
        }}
      />
      {action.error && <ErrorText>{action.error}</ErrorText>}
      <div className="flex flex-wrap items-center gap-2">
        {review ? (
          <span className="text-meta text-faint">
            Comments are added to the findings you post to the pull request from the Finish tab.
          </span>
        ) : (
          <span className="text-meta text-faint">
            Comments become force-fixed findings for the implementer.
            {task.gate === "escalation" &&
              " Sending runs one more fix round instead of accepting the code as is."}
            {task.gate === "triage" && " Approving triage fixes them in its fix round."}
          </span>
        )}
        <span className="flex-1" />
        <span className="mono text-[11px] text-muted-foreground">
          {comments.length} {comments.length === 1 ? "draft" : "drafts"}
        </span>
        <Button variant="primary" disabled={!canSend} onClick={send}>
          {action.pending ? "Sending…" : sendLabel}
          <Kbd onFill aria-hidden="true">
            {modKeyLabel("↵")}
          </Kbd>
        </Button>
      </div>
    </div>
  );
}

/**
 * The task branch's changes per fix round, file by file (plain diff colors,
 * never neon). While a work task waits at finish, triage or escalation, or a
 * review task at triage, Step through walks the whole branch diff hunk by
 * hunk to comment on it.
 */
export function DiffPanel({
  task,
  diffs,
  loading,
  branchDiff,
  drafts,
  onDraftsChange,
  onSend,
  action,
}: {
  task: Task;
  diffs: readonly TaskDiff[];
  loading: boolean;
  branchDiff: BranchDiff | null | undefined;
  drafts: DiffDrafts;
  onDraftsChange: (drafts: DiffDrafts) => void;
  /** Sends the comments; resolves true once they are sent. */
  onSend: (comments: DiffCommentInput[]) => Promise<boolean>;
  action: TaskAction;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [stepping, setStepping] = useState(false);
  if (loading) return <p className={panelNote}>Loading the diff…</p>;
  if (diffs.length === 0) {
    return (
      <p className={panelNote}>
        No changes on the branch yet. The implementer commits in the Implement stage.
      </p>
    );
  }

  const hunks = branchDiff ? splitHunks(parseDiff(branchDiff.diff)) : [];
  const canComment = canCommentOnDiff(task) && hunks.length > 0;
  const showStepper = stepping && canComment;
  const drafted = draftComments(hunks, drafts).length;

  const keys = diffs.map((d) => `${d.round}:${d.reviewed}`);
  const key = selected && keys.includes(selected) ? selected : keys.at(-1)!;
  const diff = diffs[keys.indexOf(key)]!;
  const files = parseDiff(diff.diff);
  const stat = diffStat(files);

  async function send(comments: DiffCommentInput[]) {
    if (await onSend(comments)) setStepping(false);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-2.5">
        {showStepper ? (
          <span className="text-meta text-muted-foreground">
            Whole branch · {hunks.length} {hunks.length === 1 ? "hunk" : "hunks"}
          </span>
        ) : (
          <>
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
          </>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          aria-pressed={showStepper}
          disabled={!canComment}
          title={
            canComment
              ? undefined
              : task.mode === "review"
                ? "Comment on hunks once the review waits on you at triage"
                : "Comment on hunks once the task waits on you at triage, escalation or finish"
          }
          onClick={() => setStepping((v) => !v)}
        >
          {showStepper ? "Show all files" : "Step through"}
          {!showStepper && drafted > 0 && (
            <span className="mono text-[11px] text-muted-foreground">
              {drafted} {drafted === 1 ? "draft" : "drafts"}
            </span>
          )}
        </Button>
        {!showStepper && (
          <span className="mono text-[11px] text-faint">
            {diff.from.slice(0, 7)}…{diff.to.slice(0, 7)}
          </span>
        )}
      </div>
      {showStepper ? (
        <HunkStepper
          task={task}
          hunks={hunks}
          drafts={drafts}
          onDraftsChange={onDraftsChange}
          onSend={(comments) => void send(comments)}
          action={action}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
          {files.length === 0 ? (
            <p className="m-0 text-muted-foreground">This round changed no files.</p>
          ) : (
            files.map((file) => <FileDiff key={file.path} file={file} />)
          )}
        </div>
      )}
    </div>
  );
}
