import type { Agent, Step } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAgentLibrary } from "../../hooks";
import { cn } from "../../lib/utils";
import { stepEventsQuery } from "../../query";
import {
  AUTO_MODEL_LABEL,
  STAGE_LABELS,
  buildTranscript,
  defaultStepId,
  effectiveModel,
  modelTitle,
  subagentStatus,
  type TranscriptItem,
} from "../../task-view";
import { formatCost, formatTokens, sumUsage, usageTitle } from "../../usage";
import { AgentTile } from "../AgentTile";
import { panelNote } from "../classes";
import { CheckIcon, ChevronRightIcon, FailedIcon, PausedIcon } from "../icons";
import { ToolCall } from "../ToolCall";
import { ErrorText } from "../ui/field";

function stepName(step: Step, agent: Agent | undefined): string {
  const stage = STAGE_LABELS[step.stage];
  const who = step.agentId === null ? "" : ` · ${agent?.name ?? "Deleted agent"}`;
  return `${stage}${who}${step.round > 0 ? ` · r${step.round}` : ""}`;
}

function StepStatusIcon({ step }: { step: Step }) {
  switch (step.status) {
    case "running":
      return (
        <span
          aria-label="Running"
          role="img"
          className="inline-flex size-3 items-center justify-center"
        >
          <span className="size-1.5 animate-pulse-running rounded-full bg-running" />
        </span>
      );
    case "succeeded":
      return <CheckIcon size="sm" className="text-done" aria-label="Succeeded" role="img" />;
    case "failed":
      return <FailedIcon size="sm" className="text-failed" aria-label="Failed" role="img" />;
    case "interrupted":
    case "cancelled":
      return <PausedIcon size="sm" className="text-interrupted" aria-label="Stopped" role="img" />;
    default:
      return (
        <span aria-label="Pending" role="img" className="inline-flex w-3 justify-center text-faint">
          ·
        </span>
      );
  }
}

/** A collapsible sub-agent run: its brief, its own messages and tool calls, and its report. */
function SubagentCall({
  item,
  live,
}: {
  item: Extract<TranscriptItem, { kind: "subagent" }>;
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  const status = subagentStatus(item, live);
  const brief = (item.input as { prompt?: unknown } | null | undefined)?.prompt;
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-md border border-border bg-card",
        status === "running" && "border-cyan/50 shadow-glow-cyan",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 min-w-0 cursor-pointer items-center gap-2 bg-transparent px-2.5 text-left text-meta"
      >
        <ChevronRightIcon size="sm" className={cn("text-muted-foreground", open && "rotate-90")} />
        <span className="text-muted-foreground">Sub-agent</span>
        <span className="min-w-0 truncate text-foreground-strong">
          {item.description ?? item.agentType}
        </span>
        {item.description !== null && (
          <span className="mono text-[11px] text-faint">{item.agentType}</span>
        )}
        <span className="flex-1" />
        {status === "running" ? (
          <span className="mono text-[11px] text-cyan">running…</span>
        ) : status === "done" ? (
          <CheckIcon size="sm" className="text-done" aria-label="Done" role="img" />
        ) : status === "failed" ? (
          <FailedIcon size="sm" className="text-failed" aria-label="Failed" role="img" />
        ) : (
          <PausedIcon size="sm" className="text-interrupted" aria-label="Stopped" role="img" />
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
          {typeof brief === "string" && (
            <pre className="m-0 max-h-60 overflow-auto font-mono text-code whitespace-pre-wrap text-muted-foreground">
              {brief}
            </pre>
          )}
          {item.items.length === 0 ? (
            <p className="m-0 text-muted-foreground">
              {status === "running"
                ? "Standing by. No output yet."
                : "The sub-agent produced no output."}
            </p>
          ) : (
            item.items.map((child) => <TranscriptEntry key={child.key} item={child} live={live} />)
          )}
          {item.output !== null && (
            <pre
              className={cn(
                "m-0 max-h-80 overflow-auto rounded-md bg-code px-3 py-2 font-mono text-code whitespace-pre-wrap",
                item.isError ? "text-failed" : "text-foreground",
              )}
            >
              {item.output || "(no output)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function TranscriptEntry({ item, live }: { item: TranscriptItem; live: boolean }) {
  switch (item.kind) {
    case "message":
      return <p className="m-0 whitespace-pre-wrap text-foreground">{item.text}</p>;
    case "subagent":
      return <SubagentCall item={item} live={live} />;
    case "tool":
      return (
        <ToolCall
          name={item.name}
          target={item.target}
          input={item.input}
          output={item.output}
          isError={item.isError}
          live={live}
        />
      );
    case "error":
      return (
        <p className="m-0 rounded-md border border-failed/45 px-3 py-2 font-mono text-code whitespace-pre-wrap text-failed">
          {item.message}
        </p>
      );
    case "check":
      return (
        <ToolCall
          name="Ran"
          target={item.check.command}
          input={undefined}
          output={item.check.running ? null : item.check.output}
          isError={!item.check.running && item.check.exitCode !== 0}
          live={live}
        />
      );
    case "note":
      return <p className="m-0 text-meta text-faint">{item.text}</p>;
  }
}

/** The step's tokens and cost; rises live as `step.usage` patches the step. */
function StepUsageLabel({ step }: { step: Step }) {
  const total = sumUsage([step]);
  return (
    <span className="mono text-[11px] text-faint" title={usageTitle(total)}>
      {formatTokens(total.tokens)} tokens · {formatCost(total)}
    </span>
  );
}

function Transcript({
  taskId,
  step,
  agent,
  follow,
}: {
  taskId: string;
  step: Step;
  agent: Agent | undefined;
  follow: boolean;
}) {
  const events = useQuery(stepEventsQuery(taskId, step.id));
  const items = buildTranscript(events.data ?? []);
  const live = step.status === "running";
  const end = useRef<HTMLDivElement>(null);
  const count = events.data?.length ?? 0;
  const model = effectiveModel(events.data, agent, step.cli);

  useEffect(() => {
    if (follow && live) end.current?.scrollIntoView({ block: "end" });
  }, [follow, live, count]);

  return (
    <section
      aria-label="Agent output"
      aria-live={live ? "polite" : "off"}
      className="flex min-w-0 flex-1 flex-col gap-2.5 overflow-auto px-[22px] pt-3.5 pb-5"
    >
      <div className="flex items-center gap-2">
        {agent ? (
          <>
            {step.cli && <AgentTile cli={step.cli} size="lg" />}
            <span className="font-semibold text-foreground-strong">{agent.name}</span>
            <span
              className="mono max-w-40 truncate text-[11px] text-faint"
              title={modelTitle(model)}
            >
              {model.model ?? AUTO_MODEL_LABEL}
            </span>
          </>
        ) : (
          <span className="font-semibold text-foreground-strong">
            {step.agentId === null ? "blackwall" : "Deleted agent"}
          </span>
        )}
        <span className={cn("label", live ? "text-cyan" : "text-muted-foreground")}>
          {STAGE_LABELS[step.stage]}
          {step.round > 0 && ` · round ${step.round}`}
        </span>
        {step.agentId !== null && <StepUsageLabel step={step} />}
      </div>
      <div className="flex max-w-[860px] flex-col gap-2 pl-7">
        {events.isPending ? (
          <p className="m-0 text-muted-foreground">Tapping the output stream…</p>
        ) : events.isError ? (
          <ErrorText className="text-body">{events.error.message}</ErrorText>
        ) : items.length === 0 ? (
          <p className="m-0 text-muted-foreground">
            {live ? "Channel open. Waiting for first output…" : "This step produced no output."}
          </p>
        ) : (
          items.map((item) => <TranscriptEntry key={item.key} item={item} live={live} />)
        )}
        {step.error && step.status === "failed" && (
          <p className="m-0 font-mono text-code whitespace-pre-wrap text-failed">{step.error}</p>
        )}
        <div ref={end} />
      </div>
    </section>
  );
}

/** Live agent output: the run's steps on the left, the selected step's transcript on the right. */
export function OutputPanel({
  taskId,
  steps,
  loading,
}: {
  taskId: string;
  steps: readonly Step[];
  loading: boolean;
}) {
  const agentMap = useAgentLibrary();
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);

  // Following the output also follows the pipeline to the step that runs next.
  const current = follow ? defaultStepId(steps) : (selected ?? defaultStepId(steps));
  const step = steps.find((s) => s.id === current);

  if (loading) return <p className={panelNote}>Reading the step log…</p>;
  if (steps.length === 0 || !step) {
    return <p className={panelNote}>Standing by. Output streams here once the task starts.</p>;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Steps"
        className="flex w-[220px] flex-none flex-col gap-0.5 overflow-auto border-r border-border py-3.5 pr-2.5 pl-4 text-meta"
      >
        <span className="label px-1.5 pb-1.5 text-muted-foreground">Steps</span>
        {steps.map((s) => {
          const on = s.id === step.id;
          return (
            <button
              key={s.id}
              type="button"
              aria-current={on ? "step" : undefined}
              onClick={() => {
                setSelected(s.id);
                setFollow(false);
              }}
              className={cn(
                "flex min-w-0 cursor-pointer items-center gap-2 rounded-sm bg-transparent px-1.5 py-1 text-left text-muted-foreground hover:bg-card",
                on && "bg-muted text-foreground-strong hover:bg-muted",
              )}
            >
              <StepStatusIcon step={s} />
              <span className="truncate">
                {stepName(s, s.agentId ? agentMap.get(s.agentId) : undefined)}
              </span>
            </button>
          );
        })}
        <span className="flex-1" />
        <label className="mt-2 flex items-center gap-1.5 px-1.5 py-1 text-muted-foreground">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
          />
          Follow output
        </label>
      </nav>
      <Transcript
        key={step.id}
        taskId={taskId}
        step={step}
        agent={step.agentId ? agentMap.get(step.agentId) : undefined}
        follow={follow}
      />
    </div>
  );
}
