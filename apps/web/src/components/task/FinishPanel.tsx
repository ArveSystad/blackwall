import type {
  DeliveryAction,
  DeliveryPlan,
  DeliveryTarget,
  Finding,
  Task,
} from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { isModKey, isTypingTarget, modKeyLabel } from "../../keyboard";
import { taskDeliveryQuery } from "../../query";
import { checkPassed, confirmLabel, deliveryActionCopy, isReviewTriage } from "../../task-view";
import { WallIcon } from "../icons";
import { OutboundAction } from "../OutboundAction";
import { SeverityChip } from "../SeverityChip";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { answerGate } from "./actions";
import type { TaskData } from "./use-task-data";
import type { TaskAction } from "./use-task-action";

const TARGET_LABELS: Record<DeliveryTarget, string> = {
  "push-branch": "Pushed the branch",
  "open-pr": "Opened a pull request",
  "pr-comment": "Commented on the pull request",
  "jira-comment": "Commented on the Jira issue",
  "merge-main": "Merged into local main",
  "pr-review": "Posted the review",
};

function Summary({ task, data }: { task: Task; data: TaskData }) {
  const findings = data.visibleFindings;
  const fixed = findings.filter((f) => f.status === "fixed").length;
  const ignored = findings.filter((f) => f.status === "force-ignore").length;
  const open = findings.filter((f) => f.status === "open" || f.status === "force-fix").length;
  const passed = data.checks.filter(checkPassed).length;
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
          <div className="max-w-[680px] whitespace-pre-wrap text-foreground">{task.summary}</div>
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
                <li key={target}>{TARGET_LABELS[target]}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function ReviewFindings({
  ids,
  findings,
  selected,
  onChange,
}: {
  ids: readonly string[];
  findings: readonly Finding[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const offered = ids.flatMap((id) => findings.filter((f) => f.id === id));
  if (offered.length === 0) {
    return <p className="m-0 text-meta text-muted-foreground">No findings to post.</p>;
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {offered.map((f) => (
        <li key={f.id}>
          <label className="flex min-w-0 cursor-pointer items-center gap-2 text-meta">
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
            <span className="truncate text-foreground">{f.title}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function Outbound({
  task,
  plan,
  findings,
  action,
  draft,
}: {
  task: Task;
  plan: DeliveryPlan;
  findings: readonly Finding[];
  action: TaskAction;
  draft: string;
}) {
  const done = new Set(plan.completed);
  const [ticked, setTicked] = useState<ReadonlySet<DeliveryTarget>>(
    () => new Set(plan.actions.map((a) => a.kind).filter((k) => !done.has(k))),
  );
  const [squash, setSquash] = useState(false);
  const review = plan.actions.find(
    (a): a is Extract<DeliveryAction, { kind: "pr-review" }> => a.kind === "pr-review",
  );
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(review?.findingIds));

  const chosen = plan.actions.map((a) => a.kind).filter((k) => ticked.has(k) && !done.has(k));
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
        },
      },
      reviewing ? "Post review" : "Finish",
    );
  }

  const confirmRef = useRef(confirm);
  useEffect(() => {
    confirmRef.current = confirm;
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter" || !isModKey(event) || isTypingTarget(event.target)) return;
      event.preventDefault();
      confirmRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
          const copy = deliveryActionCopy(a, picked.size);
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
                  ids={a.findingIds}
                  findings={findings}
                  selected={picked}
                  onChange={setPicked}
                />
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

/**
 * Finish: the summary on the left, and on the right every outbound action
 * as a pre-ticked checkbox showing exactly what is sent. Nothing leaves the
 * machine until the user confirms here.
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

  return (
    <div className="flex min-h-0 flex-1 flex-wrap">
      <Summary task={task} data={data} />
      {atGate && (
        <aside
          aria-label="Outbound actions"
          className="flex h-full max-w-[500px] min-w-0 flex-[1_1_440px] flex-col border-l border-border bg-sidebar"
        >
          <div className="flex flex-col gap-1 border-b border-border px-[18px] pt-3.5 pb-3">
            <span className="flex items-center gap-2">
              <WallIcon size="lg" className="text-magenta" />
              <span className="label text-magenta">Outbound · crosses the wall</span>
            </span>
            <span className="text-[12.5px] text-foreground">
              Nothing leaves this machine until you confirm. Untick anything you want to keep local.
            </span>
          </div>
          {plan.isPending ? (
            <p className="m-0 px-[18px] py-3 text-muted-foreground">Working out what to send…</p>
          ) : plan.isError ? (
            <div className="flex flex-col items-start gap-2 px-[18px] py-3">
              <p className="m-0 text-destructive">{plan.error.message}</p>
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
            />
          )}
        </aside>
      )}
    </div>
  );
}
