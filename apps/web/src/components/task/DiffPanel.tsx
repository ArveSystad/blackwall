import {
  isUserComment,
  type Agent,
  type BranchDiff,
  type DiffCommentInput,
  type Finding,
  type PullRequestThread,
  type Task,
  type TaskDiff,
} from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { freshIds } from "../../chat";
import { useAgentLibrary } from "../../hooks";
import {
  isModKey,
  isPlainKey,
  isTypingTarget,
  modKeyLabel,
  useWindowKeydown,
} from "../../keyboard";
import { cn } from "../../lib/utils";
import { taskPrCommentsQuery } from "../../query";
import {
  canCommentOnDiff,
  canStepThroughDiff,
  diffCommentsRunFixRound,
  diffStat,
  findingLocation,
  findingsOffDiff,
  hunkFindings,
  hunkThreads,
  inlineFindings,
  parseDiff,
  splitHunks,
  unplacedThreads,
  type DiffFile,
  type DiffHunk,
} from "../../task-view";
import { panelNote } from "../classes";
import { DiffView } from "../DiffView";
import { ChevronRightIcon } from "../icons";
import { Markdown } from "../Markdown";
import { Segmented } from "../Segmented";
import { SeverityChip } from "../SeverityChip";
import { Button } from "../ui/button";
import { Tag } from "../ui/chip";
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

/** The findings as a list of read-only cards, without fading in. */
function FindingList({
  findings,
  agents,
}: {
  findings: readonly Finding[];
  agents: ReadonlyMap<string, Agent>;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {findings.map((finding) => (
        <HunkFinding
          key={finding.id}
          finding={finding}
          reviewer={finding.reviewerAgentId ? agents.get(finding.reviewerAgentId) : undefined}
          fadeIn={false}
        />
      ))}
    </ul>
  );
}

/**
 * A file's diff, with its findings under the lines they point at and the rest
 * above the diff; a binary or mode-only file shows them all above.
 */
function FileDiff({
  file,
  findings,
  agents,
}: {
  file: DiffFile;
  findings: readonly Finding[];
  agents: ReadonlyMap<string, Agent>;
}) {
  const [open, setOpen] = useState(true);
  // A binary or mode-only file has no lines to anchor on, so all its findings are file-level.
  const { fileLevel, afterLine } = inlineFindings(file, findings);
  const count = fileLevel.length + [...afterLine.values()].flat().length;
  const annotations = new Map(
    [...afterLine].map(([i, list]) => [i, <FindingList findings={list} agents={agents} />]),
  );
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
        {count > 0 && (
          <span className="text-meta text-muted-foreground">
            {count} {count === 1 ? "finding" : "findings"}
          </span>
        )}
      </button>
      {open && fileLevel.length > 0 && <FindingList findings={fileLevel} agents={agents} />}
      {open &&
        (file.lines.length === 0 ? (
          <p className="m-0 pl-5 text-meta text-muted-foreground">Binary file or mode change.</p>
        ) : (
          <DiffView lines={file.lines} annotations={annotations} />
        ))}
    </section>
  );
}

/** A GitHub comment's fade id, apart from finding ids. */
const threadCommentId = (comment: PullRequestThread["comments"][number]) => `gh:${comment.id}`;

/** A review thread already on the pull request, read-only, with its replies indented. */
function PrThread({ thread, fading }: { thread: PullRequestThread; fading: ReadonlySet<string> }) {
  const where = thread.outdated
    ? null
    : thread.startLine !== null && thread.startLine !== thread.line
      ? `${thread.path}:${thread.startLine}-${thread.line}`
      : `${thread.path}:${thread.line}`;
  return (
    <li className="bw-chamfer-box flex flex-col gap-2 border-dashed px-3 py-2.5 [--bw-chamfer-line:var(--border)]">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="label text-muted-foreground">GitHub</span>
        {where && <span className="mono truncate text-[11px] text-muted-foreground">{where}</span>}
        {thread.outdated && <Tag>Outdated</Tag>}
        <span className="flex-1" />
        {thread.url && (
          <a
            href={thread.url}
            target="_blank"
            rel="noreferrer"
            className="text-meta text-primary underline"
          >
            View on GitHub
          </a>
        )}
      </div>
      {thread.comments.map((comment, i) => (
        <div
          key={comment.id}
          className={cn(
            "flex min-w-0 flex-col gap-1",
            i > 0 && "ml-4 border-l-2 border-border pl-3",
            fading.has(threadCommentId(comment)) && "animate-fade-in",
          )}
        >
          <span className="text-meta text-muted-foreground">
            <span className="text-foreground-strong">{comment.author}</span>
            {comment.createdAt && (
              <>
                {" · "}
                <time dateTime={comment.createdAt.toISOString()}>
                  {comment.createdAt.toLocaleDateString()}
                </time>
              </>
            )}
          </span>
          <Markdown>{comment.body}</Markdown>
        </div>
      ))}
    </li>
  );
}

/** A reviewer's finding on the hunk, read-only; settled ones are struck through. */
function HunkFinding({
  finding,
  reviewer,
  fadeIn,
}: {
  finding: Finding;
  reviewer: Agent | undefined;
  fadeIn: boolean;
}) {
  const settled = finding.status === "force-ignore" || finding.status === "fixed";
  const location = findingLocation(finding);
  return (
    <li
      className={cn(
        "bw-chamfer flex flex-col gap-1.5 bg-card px-3 py-2.5 [--bw-chamfer-line:var(--border)]",
        fadeIn && "animate-fade-in",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <SeverityChip severity={finding.severity} />
        <span
          className={cn(
            "min-w-0 truncate text-foreground-strong",
            settled && "text-faint line-through",
          )}
        >
          {finding.title}
        </span>
        <span className="flex-1" />
        <span className="text-meta text-muted-foreground">
          {reviewer?.name ?? (isUserComment(finding) ? "You" : "Checks")}
        </span>
        {location && (
          <span className="mono truncate text-[11px] text-muted-foreground">{location}</span>
        )}
      </div>
      <p className={cn("m-0 whitespace-pre-wrap text-foreground", settled && "text-faint")}>
        {finding.explanation}
      </p>
    </li>
  );
}

/**
 * Which comments fade in: those that arrive after the stepper first rendered
 * with them. The PR's threads are seeded on their own once they first load.
 */
interface FadeState {
  seen: ReadonlySet<string>;
  fading: ReadonlySet<string>;
  threadsSeeded: boolean;
}

/**
 * One hunk of the branch diff at a time, with the comments already on it (the
 * PR's GitHub threads, then the reviewers' findings, both as they arrive) and
 * a comment box. ←/→ step through the hunks; the drafts are sent together as
 * findings: force-fixed for the implementer, or in a review task, open to post
 * to the pull request. A review task can be stepped through and drafted on
 * while it runs; sending waits for `canComment`.
 */
function HunkStepper({
  task,
  hunks,
  findings,
  threads,
  threadsError,
  canComment,
  drafts,
  onDraftsChange,
  onSend,
  action,
}: {
  task: Task;
  hunks: readonly DiffHunk[];
  findings: readonly Finding[];
  /** The PR's review threads; undefined until they load, or for tasks that are not PRs. */
  threads: readonly PullRequestThread[] | undefined;
  threadsError: string | null;
  canComment: boolean;
  drafts: DiffDrafts;
  onDraftsChange: (drafts: DiffDrafts) => void;
  onSend: (comments: DiffCommentInput[]) => void;
  action: TaskAction;
}) {
  const agents = useAgentLibrary();
  const [position, setPosition] = useState(0);
  const [fade, setFade] = useState<FadeState | null>(null);
  const at = Math.min(position, hunks.length - 1);
  const hunk = hunks[at]!;
  const key = draftKey(hunk);
  const paths = [...new Set(hunks.map((h) => h.path))];
  const inFile = hunks.filter((h) => h.path === hunk.path).length;
  const comments = draftComments(hunks, drafts);
  const canSend = canComment && comments.length > 0 && !action.pending;

  // Seed the seen ids on the first render, so comments already there show without fading.
  const threadItems = threads?.flatMap((t) => t.comments.map((c) => ({ id: threadCommentId(c) })));
  const items = [...findings, ...(threadItems ?? [])];
  if (fade === null) {
    setFade({
      seen: new Set(items.map((item) => item.id)),
      fading: new Set(),
      threadsSeeded: threadItems !== undefined,
    });
  } else {
    const seedThreads = !fade.threadsSeeded && threadItems !== undefined;
    const quiet = new Set(seedThreads ? threadItems.map((item) => item.id) : []);
    const fresh = freshIds(items, fade.seen).filter((id) => !quiet.has(id));
    if (seedThreads || fresh.length > 0) {
      setFade({
        seen: new Set([...fade.seen, ...quiet, ...fresh]),
        fading: new Set([...fade.fading, ...fresh]),
        threadsSeeded: fade.threadsSeeded || seedThreads,
      });
    }
  }
  const fading = fade?.fading ?? new Set<string>();

  const onHunk = hunkFindings(hunk, findings);
  const threadsOnHunk = threads ? hunkThreads(hunk, threads) : [];
  const commentCount = onHunk.length + threadsOnHunk.length;
  const unplaced = threads ? unplacedThreads(hunks, threads) : 0;

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
          {commentCount > 0 && ` · ${commentCount} ${commentCount === 1 ? "comment" : "comments"}`}
        </span>
        {unplaced > 0 && task.origin.kind === "github-pr" && (
          <a
            href={task.origin.url}
            target="_blank"
            rel="noreferrer"
            className="text-meta text-primary underline"
          >
            {unplaced} GitHub {unplaced === 1 ? "thread" : "threads"} outside these hunks
          </a>
        )}
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
      {review && task.status === "running" && (
        <p className="m-0 flex items-center gap-2 text-meta text-muted-foreground">
          <span className="size-1.5 flex-none animate-pulse-running rounded-full bg-running" />
          Reviewers are still working; their comments appear here as each one finishes.
        </p>
      )}
      {threadsError && <p className="m-0 text-meta text-faint">{threadsError}</p>}
      {commentCount > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {threadsOnHunk.map((thread) => (
            <PrThread key={`gh:${thread.id}`} thread={thread} fading={fading} />
          ))}
          {onHunk.map((finding) => (
            <HunkFinding
              key={finding.id}
              finding={finding}
              reviewer={finding.reviewerAgentId ? agents.get(finding.reviewerAgentId) : undefined}
              fadeIn={fading.has(finding.id)}
            />
          ))}
        </ul>
      )}
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
            {canComment
              ? "Comments are added to the findings you post to the pull request from the Finish tab."
              : "Send once the review waits on you at triage."}
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
 * never neon). In a review task, the reviewers' findings show under the diff
 * lines they point at, as on GitHub; those off the diff are counted in the
 * toolbar. Step through walks the whole branch diff hunk by hunk to
 * comment on it: in a work task while it waits at finish, triage or
 * escalation; in a review task at any time, with each hunk's findings as the
 * reviewers report them and the PR's GitHub review threads (polled while
 * stepping), though comments are sent only at triage.
 */
export function DiffPanel({
  task,
  diffs,
  loading,
  branchDiff,
  findings,
  drafts,
  onDraftsChange,
  onSend,
  action,
}: {
  task: Task;
  diffs: readonly TaskDiff[];
  loading: boolean;
  branchDiff: BranchDiff | null | undefined;
  /** The task's visible findings, shown on the hunks they point at. */
  findings: readonly Finding[];
  drafts: DiffDrafts;
  onDraftsChange: (drafts: DiffDrafts) => void;
  /** Sends the comments; resolves true once they are sent. */
  onSend: (comments: DiffCommentInput[]) => Promise<boolean>;
  action: TaskAction;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [stepping, setStepping] = useState(false);
  const prComments = useQuery({
    ...taskPrCommentsQuery(task.id),
    enabled: stepping && task.mode === "review" && task.origin.kind === "github-pr",
  });
  const agents = useAgentLibrary();
  if (loading) return <p className={panelNote}>Reading the diff…</p>;
  if (diffs.length === 0) {
    return (
      <p className={panelNote}>Branch untouched. The implementer commits in the Implement stage.</p>
    );
  }

  const hunks = branchDiff ? splitHunks(parseDiff(branchDiff.diff)) : [];
  const canStep = canStepThroughDiff(task) && hunks.length > 0;
  const showStepper = stepping && canStep;
  const drafted = draftComments(hunks, drafts).length;

  const keys = diffs.map((d) => `${d.round}:${d.reviewed}`);
  const key = selected && keys.includes(selected) ? selected : keys.at(-1)!;
  const diff = diffs[keys.indexOf(key)]!;
  const files = parseDiff(diff.diff);
  const stat = diffStat(files);
  // A review task's findings come from its latest run and point at that run's
  // reviewed head, which its diff shows;
  // a work task's fix rounds each move the head, so its findings stay off the diff.
  const inline = task.mode === "review" ? findings : [];
  const offDiff = findingsOffDiff(files, inline);

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
            {offDiff > 0 && (
              <span className="text-meta text-muted-foreground">
                {offDiff} {offDiff === 1 ? "finding" : "findings"} outside this diff — see Findings
              </span>
            )}
          </>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          aria-pressed={showStepper}
          disabled={!canStep}
          title={
            canStep || task.mode === "review"
              ? undefined
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
          findings={findings}
          threads={prComments.data?.threads}
          threadsError={prComments.data?.error ?? null}
          canComment={canCommentOnDiff(task)}
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
            files.map((file) => (
              <FileDiff key={file.path} file={file} findings={inline} agents={agents} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
