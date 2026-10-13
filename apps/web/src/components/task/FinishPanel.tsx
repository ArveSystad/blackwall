import {
  isUserComment,
  type DeliveryAction,
  type DeliveryPlan,
  type DeliveryTarget,
  type Finding,
  type Task,
} from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteFinding } from "../../api";
import { isModKey, isTypingTarget, modKeyLabel, useWindowKeydown } from "../../keyboard";
import { queryKeys, taskDeliveryQuery } from "../../query";
import { errorMessage } from "../../settings-forms";
import {
  canDeleteFinding,
  carryPicks,
  checkPassed,
  confirmLabel,
  deliveryActionCopy,
  isReviewTriage,
} from "../../task-view";
import { WallIcon } from "../icons";
import { Markdown } from "../Markdown";
import { OutboundAction } from "../OutboundAction";
import { SeverityChip } from "../SeverityChip";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/field";
import { Kbd } from "../ui/kbd";
import { answerGate } from "./actions";
import type { TaskData } from "./use-task-data";
import type { TaskAction } from "./use-task-action";

const TARGET_LABELS: Record<DeliveryTarget, string> = {
  "push-branch": "Pushed the branch",
  "open-pr": "Opened a pull request",
  "pr-comment": "Commented on the pull request",
  "jira-comment": "Commented on the Jira issue",
  "issue-comment": "Commented on the issue",
  "merge-main": "Merged into local main",
  "pr-review": "Posted the review",
  "create-tasks": "Created follow-up tasks",
};

function Summary({ task, data }: { task: Task; data: TaskData }) {
  const findings = data.visibleFindings;
  const fixed = findings.filter((f) => f.status === "fixed").length;
  const ignored = findings.filter((f) => f.status === "force-ignore").length;
  const open = findings.filter((f) => f.status === "open" || f.status === "force-fix").length;
  const passed = data.checks.filter(checkPassed).length;
  const resolved = [...new Set(data.deliveryConflicts.flatMap((c) => c.files))];
  return (
    <section
      aria-label="Summary"
      className="flex h-full min-w-0 flex-[999_1_480px] flex-col gap-4 overflow-auto px-6 pt-[18px] pb-6"
    >
      <div className="flex flex-wrap gap-x-[18px] gap-y-1.5 text-meta text-muted-foreground">
        {task.mode !== "review" && (
          <span>
            <span className="mono text-foreground-strong">{data.round}</span>{" "}
            {data.round === 1 ? "fix round" : "fix rounds"}
          </span>
        )}
        <span>
          <span className="mono text-foreground-strong">{fixed}</span> findings fixed,{" "}
          <span className="mono text-foreground-strong">{ignored}</span> ignored,{" "}
          <span className="mono text-foreground-strong">{open}</span> open
        </span>
        {data.checks.length > 0 && (
          <span className={passed === data.checks.length ? "text-done" : "text-failed"}>
            Checks {passed}/{data.checks.length} passed
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <span className="label text-muted-foreground">Summary</span>
        {task.summary ? (
          <Markdown className="max-w-[680px]">{task.summary}</Markdown>
        ) : (
          <p className="m-0 text-muted-foreground">
            {task.mode === "review"
              ? "Review PR tasks post their findings; there is no summary."
              : "No summary yet. The summarizer writes it before finish."}
          </p>
        )}
      </div>
      {task.status === "done" && (
        <div className="flex flex-col gap-2">
          <span className="label text-muted-foreground">Delivered</span>
          {task.deliveryTargets.length === 0 ? (
            <p className="m-0 text-foreground">Kept local. Nothing left this machine.</p>
          ) : (
            <ul className="m-0 flex flex-col gap-1 pl-[18px]">
              {task.deliveryTargets.map((target) => (
                <li key={target}>
                  {TARGET_LABELS[target]}
                  {target === "merge-main" && resolved.length > 0 && (
                    <span className="text-muted-foreground">
                      {" "}
                      (resolved conflicts in <span className="mono">{resolved.join(", ")}</span>)
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** The findings a review posts, each pickable and, where allowed, deletable. */
function ReviewFindings({
  task,
  ids,
  findings,
  selected,
  onChange,
}: {
  task: Task;
  ids: readonly string[];
  findings: readonly Finding[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(finding: Finding) {
    setPending(finding.id);
    setError(null);
    try {
      const { deletedIds } = await deleteFinding(task.id, finding.id);
      const deleted = new Set(deletedIds);
      queryClient.setQueryData<Finding[]>(queryKeys.taskFindings(task.id), (list) =>
        list?.filter((f) => !deleted.has(f.id)),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskDelivery(task.id) });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  }

  const offered = ids.flatMap((id) => findings.filter((f) => f.id === id));
  if (offered.length === 0) {
    return <p className="m-0 text-meta text-muted-foreground">No findings to post.</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {offered.map((f) => (
          <li key={f.id} className="flex min-w-0 items-center gap-2">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-meta">
              <input
                type="checkbox"
                checked={selected.has(f.id)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(f.id);
                  else next.delete(f.id);
                  onChange(next);
                }}
              />
              <SeverityChip severity={f.severity} />
              {isUserComment(f) && <span className="text-muted-foreground">You</span>}
              <span className="truncate text-foreground">{f.title}</span>
            </label>
            {canDeleteFinding(task, f) && (
              <Button
                size="sm"
                variant="ghost"
                className="hover:text-destructive"
                disabled={pending !== null}
                title="Deletes this finding; it will not be posted"
                onClick={() => void remove(f)}
              >
                Delete
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}

type FollowUpItem = Extract<DeliveryAction, { kind: "create-tasks" }>["items"][number];

function FollowUpPicks({
  items,
  selected,
  onChange,
}: {
  items: readonly FollowUpItem[];
  selected: ReadonlySet<number>;
  onChange: (next: Set<number>) => void;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {items.map((item, index) => (
        <li key={index}>
          <label className="flex min-w-0 cursor-pointer items-start gap-2 text-meta">
            <input
              type="checkbox"
              className="mt-0.5 flex-none"
              checked={selected.has(index)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(index);
                else next.delete(index);
                onChange(next);
              }}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-foreground">{item.title}</span>
              <span className="mono truncate text-muted-foreground">{item.repoName}</span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/** The review findings offered for posting and those the user picked, as of the last plan. */
interface ReviewPicks {
  offered: ReadonlySet<string>;
  picked: ReadonlySet<string>;
}

function Outbound({
  task,
  plan,
  findings,
  action,
  draft,
  loadPicks,
  onPicksChange,
}: {
  task: Task;
  plan: DeliveryPlan;
  findings: readonly Finding[];
  action: TaskAction;
  draft: string;
  /** The picks before the plan was refetched, to carry over (see `carryPicks`). */
  loadPicks: () => ReviewPicks | undefined;
  onPicksChange: (picks: ReviewPicks) => void;
}) {
  const done = new Set(plan.completed);
  const [ticked, setTicked] = useState<ReadonlySet<DeliveryTarget>>(
    () => new Set(plan.actions.map((a) => a.kind).filter((k) => !done.has(k))),
  );
  const [squash, setSquash] = useState(false);
  const review = plan.actions.find(
    (a): a is Extract<DeliveryAction, { kind: "pr-review" }> => a.kind === "pr-review",
  );
  const [picked, setPicked] = useState<ReadonlySet<string>>(() =>
    carryPicks(loadPicks(), review?.findingIds ?? []),
  );
  const offeredIds = review?.findingIds;
  useEffect(() => {
    onPicksChange({ offered: new Set(offeredIds), picked });
  }, [offeredIds, picked, onPicksChange]);
  const createTasks = plan.actions.find(
    (a): a is Extract<DeliveryAction, { kind: "create-tasks" }> => a.kind === "create-tasks",
  );
  const [followUps, setFollowUps] = useState<ReadonlySet<number>>(
    () => new Set(createTasks?.items.map((_, index) => index)),
  );

  // Creating no follow-ups is not creating them at all.
  const chosen = plan.actions
    .map((a) => a.kind)
    .filter((k) => ticked.has(k) && !done.has(k))
    .filter((k) => k !== "create-tasks" || followUps.size > 0);
  const reviewing = isReviewTriage(task);

  function confirm() {
    if (action.pending) return;
    void answerGate(
      action,
      task,
      {
        decision: "approve",
        delivery: {
          actions: chosen,
          squash: squash && plan.squash !== null,
          findingIds: chosen.includes("pr-review") ? [...picked] : [],
          followUpIndexes: chosen.includes("create-tasks")
            ? [...followUps].sort((a, b) => a - b)
            : [],
        },
      },
      reviewing ? "Post review" : "Finish",
    );
  }

  useWindowKeydown((event) => {
    if (event.key !== "Enter" || !isModKey(event) || isTypingTarget(event.target)) return;
    event.preventDefault();
    confirm();
  });

  function toggle(kind: DeliveryTarget, on: boolean) {
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }

  const offeredFindings = review?.findingIds.length ?? 0;
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-3.5 py-3">
        {plan.actions.length === 0 && (
          <p className="m-0 px-1 text-muted-foreground">
            Nothing to send for this task. Confirming marks it done.
          </p>
        )}
        {plan.squash && (
          <OutboundAction
            optional
            title={`Squash ${plan.squash.commits} commits into one`}
            target={`onto ${plan.squash.base.slice(0, 12)}, before anything is pushed or merged`}
            body={plan.squash.message}
            checked={squash}
            onChange={setSquash}
          />
        )}
        {plan.actions.map((a) => {
          const copy = deliveryActionCopy(
            a,
            a.kind === "create-tasks" ? followUps.size : picked.size,
          );
          return (
            <OutboundAction
              key={a.kind}
              title={copy.title}
              target={copy.target}
              body={copy.body}
              checked={ticked.has(a.kind)}
              completed={done.has(a.kind)}
              onChange={(on) => toggle(a.kind, on)}
            >
              {a.kind === "pr-review" && offeredFindings > 0 && (
                <ReviewFindings
                  task={task}
                  ids={a.findingIds}
                  findings={findings}
                  selected={picked}
                  onChange={setPicked}
                />
              )}
              {a.kind === "create-tasks" && !done.has(a.kind) && (
                <FollowUpPicks items={a.items} selected={followUps} onChange={setFollowUps} />
              )}
            </OutboundAction>
          );
        })}
      </div>
      <div className="flex flex-col gap-2 border-t border-border px-4 pt-3 pb-3.5">
        <Button
          variant="needs"
          className="h-9 justify-center text-body"
          disabled={action.pending}
          onClick={confirm}
        >
          {action.pending ? "Sending…" : confirmLabel(chosen.length)}
          <Kbd onFill aria-hidden="true">
            {modKeyLabel("↵")}
          </Kbd>
        </Button>
        {!reviewing && (
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={action.pending}
              onClick={() =>
                void answerGate(
                  action,
                  task,
                  { decision: "revise", ...(draft.trim() ? { message: draft.trim() } : {}) },
                  "Back to code review",
                )
              }
            >
              One more fix round
            </Button>
            {chosen.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={action.pending}
                onClick={() =>
                  void answerGate(
                    action,
                    task,
                    { decision: "approve", delivery: { actions: [], squash: false } },
                    "Keep local",
                  )
                }
              >
                Keep local, mark done
              </Button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** The pull request delivery opened, one click away once the task is done. */
function Delivered({ url }: { url: string }) {
  return (
    <div className="flex flex-col gap-2 px-4 pt-3 pb-3.5">
      <Button variant="needs" asChild className="h-9 justify-center text-body">
        <a href={url} target="_blank" rel="noreferrer">
          Open pull request
        </a>
      </Button>
      <span className="mono truncate text-meta text-muted-foreground" title={url}>
        {url}
      </span>
    </div>
  );
}

/**
 * Finish: the summary on the left, and on the right every outbound action
 * as a pre-ticked checkbox showing exactly what is sent. Nothing leaves the
 * machine until the user confirms here. Once done, a delivered pull request
 * stays linked from the same panel.
 */
export function FinishPanel({
  task,
  data,
  action,
  draft,
}: {
  task: Task;
  data: TaskData;
  action: TaskAction;
  draft: string;
}) {
  const atGate = task.status === "needs-you" && (task.gate === "finish" || isReviewTriage(task));
  const plan = useQuery({ ...taskDeliveryQuery(task.id), enabled: atGate });
  const resolving =
    data.deliveryStep?.status === "running" ? data.deliveryConflicts.at(-1) : undefined;
  const delivered = task.status === "done" ? data.pullRequestUrl : undefined;
  // The review picks outlive the Outbound remount each plan refetch causes.
  const picks = useRef<(ReviewPicks & { taskId: string }) | null>(null);
  const taskId = task.id;
  const loadPicks = useCallback(
    () => (picks.current?.taskId === taskId ? picks.current : undefined),
    [taskId],
  );
  const savePicks = useCallback(
    (next: ReviewPicks) => {
      picks.current = { taskId, ...next };
    },
    [taskId],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-wrap">
      <Summary task={task} data={data} />
      {(atGate || delivered) && (
        <aside
          aria-label="Outbound actions"
          className="flex h-full max-w-[500px] min-w-0 flex-[1_1_440px] flex-col border-l border-border bg-sidebar"
        >
          <div className="flex flex-col gap-1 border-b border-border px-[18px] pt-3.5 pb-3">
            <span className="flex items-center gap-2">
              <WallIcon size="lg" className="text-magenta" />
              <span className="label text-magenta">
                {atGate ? "Outbound · crosses the wall" : "Outbound · crossed the wall"}
              </span>
            </span>
            <span className="text-[12.5px] text-foreground">
              {atGate
                ? "Nothing leaves this machine until you confirm. Untick anything you want to keep local."
                : "Delivered. Your pull request is open."}
            </span>
          </div>
          {!atGate && delivered && <Delivered url={delivered} />}
          {atGate && resolving && (
            <p
              role="status"
              className="m-0 border-b border-magenta/45 bg-needs-wash px-[18px] py-2.5 text-[12.5px] text-needs"
            >
              Rebasing <span className="mono">{resolving.branch}</span> onto{" "}
              <span className="mono">{resolving.into}</span> hit conflicts in{" "}
              <span className="mono">{resolving.files.join(", ")}</span>. The implementer is
              resolving them; the merge continues on its own.
            </p>
          )}
          {!atGate ? null : plan.isPending ? (
            <p className="m-0 px-[18px] py-3 text-muted-foreground">Working out what to send…</p>
          ) : plan.isError ? (
            <div className="flex flex-col items-start gap-2 px-[18px] py-3">
              <ErrorText className="text-body">{plan.error.message}</ErrorText>
              <Button size="sm" onClick={() => void plan.refetch()}>
                Retry
              </Button>
            </div>
          ) : (
            <Outbound
              key={JSON.stringify(plan.data)}
              task={task}
              plan={plan.data}
              findings={data.findings.data ?? []}
              action={action}
              draft={draft}
              loadPicks={loadPicks}
              onPicksChange={savePicks}
            />
          )}
        </aside>
      )}
    </div>
  );
}
