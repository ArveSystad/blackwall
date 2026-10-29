import type { Agent, Stage, Task } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  DOT_SPACING,
  PULSE_DONE_S,
  PULSE_NEEDS_S,
  PULSE_RUNNING_S,
  layoutDots,
  pulseDelay,
  stageChanges,
  type GridDot,
} from "../agent-dots";
import { originKey } from "../inbox";
import { isMac } from "../keyboard";
import { cn } from "../lib/utils";
import { stepEventsQuery } from "../query";
import { GATE_REASONS, STAGE_LABELS, currentActivity, isStoppedByUser } from "../task-view";
import { AgentTile } from "./AgentTile";
import type { ArchiveLaunches } from "./use-archive-launches";
import { useResumeBursts } from "./use-resume-bursts";
import { useSupernovas } from "./use-supernovas";

const STATE_LABELS: Record<GridDot["state"], string> = {
  running: "running",
  "needs-you": "needs you",
  queued: "queued",
  done: "done",
  interrupted: "stopped mid-step",
  failed: "failed",
};

/** Card width and the margin it keeps from the overlay's edges and the dot. */
const CARD_WIDTH = 288;
const CARD_MARGIN = 8;

/** A supernova's spark streaks; styles.css angles each by its position. */
const SPARKS = [0, 1, 2, 3, 4, 5, 6, 7];

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

/** One dot: a 32px link to its task, the visible hexagon (`.bw-hex`), its lasers and its hover/focus card. */
function AgentDot({
  dot,
  task,
  agent,
  x,
  y,
  overlayWidth,
  lasers,
  delay,
  onModClick,
  waiting = false,
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
  /** Archives a done dot's task or resumes a stopped one, on Ctrl+click (⌘+click on macOS). */
  onModClick?: (() => void) | undefined;
  /** The task's resume was asked for and it has not run yet: a faint cyan ring. */
  waiting?: boolean;
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
  // A step's own dot shows its agent's activity, a sub-agent's dot the sub-agent's.
  const activity = events.data ? currentActivity(events.data, dot.subagent?.id ?? null) : null;
  const subagent = dot.subagent;

  const stage = task.stage ? STAGE_LABELS[task.stage] : null;
  const done = dot.state === "done";
  const interrupted = dot.state === "interrupted";
  const failed = dot.state === "failed";
  const stopped = interrupted && isStoppedByUser(task);
  const stateWord = stopped ? "stopped" : STATE_LABELS[dot.state];
  const label = subagent
    ? `${task.title}: sub-agent, ${subagent.description ?? subagent.agentType}`
    : done
      ? `${task.title}: ${STATE_LABELS.done}`
      : `${task.title}: ${stage ? `${stage}, ` : ""}${stateWord}`;
  const width = Math.min(CARD_WIDTH, overlayWidth - 2 * CARD_MARGIN);
  const needs = dot.state === "needs-you";
  const still = dot.state === "queued" || interrupted || failed;
  const detail = failed ? (task.error ?? "No error was recorded.") : stopped ? null : task.error;
  const modClick = isMac() ? "⌘+click" : "Ctrl+click";

  return (
    <>
      <Link
        to="/tasks/$taskId"
        params={{ taskId: task.id }}
        aria-label={label}
        aria-describedby={open ? cardId : undefined}
        style={{ left: x, top: y }}
        className={cn(
          "pointer-events-auto absolute flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:shadow-ring",
          open ? "z-20" : needs ? "z-[2]" : dot.state === "running" ? "z-[1]" : "z-0",
        )}
        onClick={
          onModClick
            ? (event) => {
                // The Link skips navigation on modified clicks; this also stops a new tab.
                if ((isMac() ? event.metaKey : event.ctrlKey) && !event.altKey) {
                  event.preventDefault();
                  onModClick();
                }
              }
            : undefined
        }
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
          style={still ? undefined : ({ "--pulse-delay": `${delay}s` } as CSSProperties)}
          className={cn(
            "bw-hex",
            dot.state === "running" && "bw-hex-running",
            needs && "bw-hex-needs",
            dot.state === "queued" && "bw-hex-queued",
            done && "bw-hex-done",
            interrupted && "bw-hex-interrupted",
            failed && "bw-hex-failed",
            subagent && "bw-hex-sub",
            waiting && still && "bw-hex-waiting",
          )}
        >
          {!still && <span className="bw-hex-pulse" />}
        </span>
        {lasers > 0 && <span key={lasers} className="bw-laser" aria-hidden="true" />}
      </Link>
      {open && (
        <div
          id={cardId}
          role="tooltip"
          style={{ left: cardLeft(x, width, overlayWidth), top: y - DOT_SPACING / 2, width }}
          className="absolute z-30 -translate-y-full drop-shadow-pop"
        >
          {/* The pop sits on the unclipped tooltip: clip-path drops the panel's own shadow. */}
          <div className="bw-chamfer flex flex-col gap-1 bg-popover p-3 text-left">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate font-medium text-foreground-strong">
                {task.title}
              </span>
              <span className="mono flex-none text-label text-muted-foreground">
                {originKey(task)}
              </span>
            </span>
            {done ? (
              <>
                <span className="label text-done">Done</span>
                <span className="text-meta text-muted-foreground">{modClick} to archive</span>
              </>
            ) : interrupted || failed ? (
              <>
                <span className="label">
                  <span className={failed ? "text-failed" : "text-interrupted"}>
                    {failed ? "Failed" : stopped ? "Stopped" : "Stopped mid-step"}
                  </span>
                  {stage && <span className="text-muted-foreground"> · {stage}</span>}
                </span>
                {detail && (
                  <span className="mono truncate text-meta text-muted-foreground">{detail}</span>
                )}
                <span className="text-meta text-muted-foreground">
                  {waiting
                    ? failed
                      ? "Retrying…"
                      : "Resuming…"
                    : `${modClick} to ${failed ? "retry" : "resume"}`}
                </span>
              </>
            ) : subagent ? (
              <>
                <span className="label text-cyan">Sub-agent</span>
                <span className="truncate text-meta text-foreground-strong">
                  {subagent.description ?? subagent.agentType}
                </span>
                {agent && <span className="text-meta text-muted-foreground">via {agent.name}</span>}
                <span className="mono truncate text-meta text-foreground">
                  {activity ?? "Starting…"}
                </span>
              </>
            ) : (
              stage && (
                <span className={cn("label", needs ? "text-magenta" : "text-cyan")}>{stage}</span>
              )
            )}
            {dot.state === "running" && !subagent && (
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
            {dot.state === "queued" && waiting && (
              <span className="text-meta text-muted-foreground">Resuming…</span>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The active agents as glowing hexagonal dots, each in a hexagonal outline
 * (`.bw-hex`), on the empty pane's grid floor (see `agent-dots.ts`): a link to
 * each task with a hover/focus card, and a laser fired upward when a task
 * changes stage. Running and needs-you dots send an 84px round ring and their
 * task a bloom (`.bw-boom`), drawn under the dots and sharing
 * each task's pulse delay. A running sub-agent is a smaller cyan dot beside
 * its task's, with no bloom. Done tasks wait as calm green dots; Ctrl+click
 * (⌘+click on macOS) archives one through `launch`, and its dot flies off
 * toward the horizon (`.bw-launch`); the inbox's Archive all done launches
 * every done dot at once through the same `launch`. Interrupted and failed tasks wait as
 * still gray and red dots; Ctrl+click resumes or retries one through
 * `useResumeBursts`, which booms it cyan once (`.bw-revive`, red when the
 * request fails) and rings it faintly until it runs. A task turning done
 * bursts green once through `useSupernovas` (`.bw-supernova`: a core flash, a
 * wide ring and sparks along the grid lines) before it settles into its calm
 * dot. Lay it over
 * `GridBackdrop` in a `relative` parent.
 */
export function GridAgents({
  dots,
  tasks,
  agents,
  launch,
}: {
  dots: readonly GridDot[];
  tasks: ReadonlyMap<string, Task>;
  agents: ReadonlyMap<string, Agent>;
  launch: ArchiveLaunches;
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
  const revive = useResumeBursts(tasks);
  const supernovas = useSupernovas(tasks);
  // Lets the inbox's Archive all done launch each done dot (one per task) from its spot.
  const { setLocate } = launch;
  useEffect(() => {
    setLocate((taskId) => layout?.get(`${taskId}:0`));
    return () => setLocate(null);
  }, [layout, setLocate]);

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
              if (
                dot.state === "queued" ||
                dot.state === "done" ||
                dot.state === "interrupted" ||
                dot.state === "failed" ||
                dot.subagent ||
                launch.launches.has(dot.taskId) ||
                !tasks.has(dot.taskId) ||
                !spot
              )
                return null;
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
            {/* Resume and retry booms; prefixed keys, so they never collide with the looping booms. */}
            {[...revive.bursts].map(([taskId, { count, tone }]) => {
              const spot = layout.get(`${taskId}:0`);
              if (!spot) return null;
              return (
                <span
                  key={`revive:${taskId}:${count}`}
                  className={cn("bw-boom bw-revive", tone === "failed" && "bw-revive-failed")}
                  style={{ left: spot.x, top: spot.y }}
                />
              );
            })}
            {/* Done supernovas; prefixed keys, so they never collide with the looping booms. */}
            {[...supernovas].map(([taskId, { batch, delayMs }]) => {
              const spot = layout.get(`${taskId}:0`);
              if (!spot || launch.launches.has(taskId)) return null;
              return (
                <span
                  key={`supernova:${taskId}:${batch}`}
                  className="bw-supernova"
                  style={
                    {
                      left: spot.x,
                      top: spot.y,
                      "--supernova-delay": `${delayMs}ms`,
                    } as CSSProperties
                  }
                >
                  {SPARKS.map((spark) => (
                    <span key={spark} className="bw-supernova-spark" />
                  ))}
                </span>
              );
            })}
          </div>
          {dots.map((dot) => {
            const task = tasks.get(dot.taskId);
            const spot = layout.get(dot.key);
            if (!task || !spot || launch.launches.has(dot.taskId)) return null;
            const period =
              dot.state === "done"
                ? PULSE_DONE_S
                : dot.state === "needs-you"
                  ? PULSE_NEEDS_S
                  : PULSE_RUNNING_S;
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
                delay={pulseDelay(dot.taskId, period)}
                onModClick={
                  dot.state === "done"
                    ? () => {
                        revive.clearError();
                        launch.archive(task, spot.x, spot.y);
                      }
                    : dot.state === "interrupted" || dot.state === "failed"
                      ? () => {
                          launch.clearError();
                          revive.resume(task);
                        }
                      : undefined
                }
                waiting={revive.waiting.has(dot.taskId)}
              />
            );
          })}
          {/* Archived done dots, flying to the horizon's centre (58%, as .bw-grid-horizon). */}
          {[...launch.launches].map(([taskId, from]) => (
            <span
              key={taskId}
              aria-hidden="true"
              className="bw-launch"
              style={
                {
                  left: from.x,
                  top: from.y,
                  "--dx": `${size.width / 2 - from.x}px`,
                  "--dy": `${0.58 * size.height - from.y}px`,
                } as CSSProperties
              }
            />
          ))}
        </>
      )}
      {(launch.error ?? revive.error) && (
        <p
          role="alert"
          className="pointer-events-auto absolute inset-x-0 bottom-16 m-0 text-center text-meta text-destructive"
        >
          {launch.error ?? revive.error}
        </p>
      )}
      <p role="status" className="sr-only">
        {revive.announcement}
      </p>
    </nav>
  );
}
