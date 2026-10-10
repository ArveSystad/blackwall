import type { Agent, Stage, Task } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  DOT_SPACING,
  PULSE_NEEDS_S,
  PULSE_RUNNING_S,
  layoutDots,
  pulseDelay,
  stageChanges,
  type GridDot,
} from "../agent-dots";
import { originKey } from "../inbox";
import { cn } from "../lib/utils";
import { stepEventsQuery } from "../query";
import { GATE_REASONS, STAGE_LABELS, currentActivity } from "../task-view";
import { AgentTile } from "./AgentTile";

const STATE_LABELS: Record<GridDot["state"], string> = {
  running: "running",
  "needs-you": "needs you",
  queued: "queued",
};

/** Card width and the margin it keeps from the overlay's edges and the dot. */
const CARD_WIDTH = 288;
const CARD_MARGIN = 8;

/** Left edge of a card of `width` above a dot at `x`: right of it if it fits, else left, else the roomier side, kept inside. */
function cardLeft(x: number, width: number, overlayWidth: number): number {
  const fitsRight = x + width + CARD_MARGIN <= overlayWidth;
  const fitsLeft = x - width - CARD_MARGIN >= 0;
  const left = fitsRight || (!fitsLeft && overlayWidth - x >= x) ? x : x - width;
  return Math.max(CARD_MARGIN, Math.min(left, overlayWidth - CARD_MARGIN - width));
}

function stageMap(tasks: ReadonlyMap<string, Task>): Map<string, Stage | null> {
  return new Map([...tasks.values()].map((task) => [task.id, task.stage]));
}

/** One dot: a 24px link to its task, the visible dot, its lasers and its hover/focus card. */
function AgentDot({
  dot,
  task,
  agent,
  x,
  y,
  overlayWidth,
  lasers,
  delay,
}: {
  dot: GridDot;
  task: Task;
  agent: Agent | undefined;
  x: number;
  y: number;
  overlayWidth: number;
  lasers: number;
  /** The task's pulse delay in seconds, shared with its boom. */
  delay: number;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = (hovered || focused) && !dismissed;
  const cardId = useId();
  const events = useQuery({
    ...stepEventsQuery(task.id, dot.stepId ?? ""),
    enabled: open && dot.stepId !== null,
  });
  const activity = events.data ? currentActivity(events.data) : null;

  const stage = task.stage ? STAGE_LABELS[task.stage] : null;
  const label = `${task.title}: ${stage ? `${stage}, ` : ""}${STATE_LABELS[dot.state]}`;
  const width = Math.min(CARD_WIDTH, overlayWidth - 2 * CARD_MARGIN);
  const needs = dot.state === "needs-you";

  return (
    <>
      <Link
        to="/tasks/$taskId"
        params={{ taskId: task.id }}
        aria-label={label}
        aria-describedby={open ? cardId : undefined}
        style={{ left: x, top: y }}
        className={cn(
          "pointer-events-auto absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:shadow-ring",
          open ? "z-20" : needs ? "z-[2]" : dot.state === "running" ? "z-[1]" : "z-0",
        )}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") setHovered(true);
        }}
        onPointerLeave={() => {
          setHovered(false);
          if (!focused) setDismissed(false);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (!hovered) setDismissed(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            setDismissed(true);
          }
        }}
      >
        <span
          aria-hidden="true"
          style={dot.state === "queued" ? undefined : { animationDelay: `${delay}s` }}
          className={cn(
            "rounded-full",
            dot.state === "running" && "size-2 animate-pulse-running bg-running shadow-glow-cyan",
            needs && "size-2.5 animate-pulse-needs bg-needs shadow-glow-needs",
            dot.state === "queued" && "size-2 bg-faint opacity-60",
          )}
        />
        {lasers > 0 && <span key={lasers} className="bw-laser" aria-hidden="true" />}
      </Link>
      {open && (
        <div
          id={cardId}
          role="tooltip"
          style={{ left: cardLeft(x, width, overlayWidth), top: y - DOT_SPACING / 2, width }}
          className="absolute z-30 flex -translate-y-full flex-col gap-1 rounded-lg bg-popover p-3 text-left shadow-pop"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-medium text-foreground-strong">
              {task.title}
            </span>
            <span className="mono flex-none text-label text-muted-foreground">
              {originKey(task)}
            </span>
          </span>
          {stage && (
            <span className={cn("label", needs ? "text-magenta" : "text-cyan")}>{stage}</span>
          )}
          {dot.state === "running" && (
            <>
              {agent && (
                <span className="flex items-center gap-2 text-meta">
                  {dot.cli && <AgentTile cli={dot.cli} />}
                  <span className="text-foreground-strong">{agent.name}</span>
                </span>
              )}
              <span className="mono truncate text-meta text-foreground">
                {activity ?? "Starting…"}
              </span>
            </>
          )}
          {needs && task.gate && (
            <span className="text-meta text-magenta">{GATE_REASONS[task.gate]}</span>
          )}
          {dot.state === "queued" && (
            <span className="text-meta text-muted-foreground">Queued</span>
          )}
        </div>
      )}
    </>
  );
}

/**
 * The active agents as glowing dots on the empty pane's grid floor (see
 * `agent-dots.ts`): a link to each task with a hover/focus card, and a laser
 * fired upward when a task changes stage. Running and needs-you dots send a
 * ring and their task a bloom (`.bw-boom`), drawn under the dots and sharing
 * each task's pulse delay. Lay it over `GridBackdrop` in a `relative` parent.
 */
export function GridAgents({
  dots,
  tasks,
  agents,
}: {
  dots: readonly GridDot[];
  tasks: ReadonlyMap<string, Task>;
  agents: ReadonlyMap<string, Agent>;
}) {
  const ref = useRef<HTMLElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(
    () => (size ? layoutDots(dots, size.width, size.height) : null),
    [dots, size],
  );

  // Stages seen so far, compared on each tasks update; a change fires that task's lasers.
  const [seenTasks, setSeenTasks] = useState(tasks);
  const [stages, setStages] = useState(() => stageMap(tasks));
  const [lasers, setLasers] = useState<ReadonlyMap<string, number>>(new Map());
  if (tasks !== seenTasks) {
    setSeenTasks(tasks);
    setStages(stageMap(tasks));
    const changed = stageChanges(stages, [...tasks.values()]);
    if (changed.length > 0) {
      const next = new Map(lasers);
      for (const id of changed) next.set(id, (next.get(id) ?? 0) + 1);
      setLasers(next);
    }
  }

  return (
    <nav
      ref={ref}
      aria-label="Active agents"
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
    >
      {size && layout && (
        <>
          {/* Booms: keep this layer first and without a z-index, so it paints under every dot. */}
          <div aria-hidden="true" className="absolute inset-0">
            {dots.map((dot) => {
              const spot = layout.get(dot.key);
              if (dot.state === "queued" || !tasks.has(dot.taskId) || !spot) return null;
              const needs = dot.state === "needs-you";
              const delay = pulseDelay(dot.taskId, needs ? PULSE_NEEDS_S : PULSE_RUNNING_S);
              return (
                <span
                  key={dot.key}
                  className={cn(
                    "bw-boom",
                    needs && "bw-boom-needs",
                    dot.slot > 0 && "bw-boom-ring",
                  )}
                  style={
                    { left: spot.x, top: spot.y, "--pulse-delay": `${delay}s` } as CSSProperties
                  }
                />
              );
            })}
          </div>
          {dots.map((dot) => {
            const task = tasks.get(dot.taskId);
            const spot = layout.get(dot.key);
            if (!task || !spot) return null;
            const needs = dot.state === "needs-you";
            return (
              <AgentDot
                key={dot.key}
                dot={dot}
                task={task}
                agent={dot.agentId ? agents.get(dot.agentId) : undefined}
                x={spot.x}
                y={spot.y}
                overlayWidth={size.width}
                lasers={lasers.get(dot.taskId) ?? 0}
                delay={pulseDelay(dot.taskId, needs ? PULSE_NEEDS_S : PULSE_RUNNING_S)}
              />
            );
          })}
        </>
      )}
    </nav>
  );
}
