import type { ActiveAgentStep, Task } from "@blackwall/shared";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  PACKET_MS,
  admitPacket,
  packetFor,
  type PacketKind,
  type PacketResolve,
} from "../data-packets";
import { useLiveEvent } from "../live-status";
import { queryKeys, taskRunsQuery } from "../query";
import { prefersReducedMotion } from "../reduced-motion";

/** One packet on its way from a task's dot to its repo's tower. */
export interface DataPacket {
  taskId: string;
  kind: PacketKind;
  /** Counts up per packet; part of the React key. */
  n: number;
}

/**
 * Data packets on the grid (`GridAgents`): a light from a task's dot to its
 * repo's tower for each real event in the task, read from the live event bus
 * (`useLiveEvent`): a step that succeeded, the round's commit (a harness
 * Checks step starting), a finished check (green or red) and a new finding
 * (see `packetFor`). Tool calls send nothing. Steps carry only their run, so
 * runs of the running and needs-you tasks are loaded to map them to their
 * task, topped up by `run.upserted`; a step that still can't be placed falls
 * back to the cached active agents. Packets come only from live events, so a
 * reload or remount never replays one. `admitPacket` lets one per task through
 * every 2 s and 6 at once; the rest are dropped. Each is dropped after
 * `PACKET_MS` (a timeout). Under reduced motion the hook never subscribes and
 * loads no runs.
 */
export function useDataPackets(tasks: ReadonlyMap<string, Task>): ReadonlyMap<string, DataPacket> {
  const queryClient = useQueryClient();
  const [reduced] = useState(prefersReducedMotion);
  const [packets, setPackets] = useState<ReadonlyMap<string, DataPacket>>(new Map());

  const live = [...tasks.values()].filter(
    (task) => !task.archivedAt && (task.status === "running" || task.status === "needs-you"),
  );
  const runLists = useQueries({
    queries: live.map((task) => ({ ...taskRunsQuery(task.id), enabled: !reduced })),
  });

  const tasksRef = useRef(tasks);
  const runTasks = useRef(new Map<string, string>());
  const stepTasks = useRef(new Map<string, string>());
  const seen = useRef(new Set<string>());
  const lastByTask = useRef(new Map<string, number>());
  const inFlight = useRef(0);
  const counter = useRef(0);
  const timers = useRef(new Set<number>());

  useEffect(() => {
    tasksRef.current = tasks;
    for (const list of runLists) {
      for (const run of list.data ?? []) runTasks.current.set(run.id, run.taskId);
    }
  });

  useLiveEvent((event) => {
    if (event.type === "run.upserted") {
      const { run } = event.payload;
      runTasks.current.set(run.id, run.taskId);
    }
    if (event.type === "step.upserted") {
      const { step } = event.payload;
      // Before its refetch lands, the cached list still has a step that just finished.
      const taskId =
        runTasks.current.get(step.runId) ??
        queryClient
          .getQueryData<ActiveAgentStep[]>(queryKeys.activeAgents)
          ?.find((active) => active.id === step.id)?.taskId;
      if (taskId) stepTasks.current.set(step.id, taskId);
    }
    const resolve: PacketResolve = {
      run: (runId) => runTasks.current.get(runId),
      step: (stepId) => stepTasks.current.get(stepId),
    };
    const now = Date.now();
    const hit = packetFor(event, resolve, seen.current, now);
    if (!hit) return;
    const task = tasksRef.current.get(hit.taskId);
    if (!task || task.archivedAt) return;
    if (!admitPacket(lastByTask.current, hit.taskId, now, inFlight.current)) return;

    const n = ++counter.current;
    const id = `packet:${n}`;
    inFlight.current++;
    setPackets((prev) => new Map(prev).set(id, { taskId: hit.taskId, kind: hit.kind, n }));
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      inFlight.current--;
      setPackets((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }, PACKET_MS);
    timers.current.add(timer);
  }, !reduced);

  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const timer of running) window.clearTimeout(timer);
      running.clear();
    };
  }, []);

  return packets;
}
