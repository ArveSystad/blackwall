import type { ServerEvent } from "@blackwall/shared";

/**
 * Data packets on the home grid: a light that runs from a task's dot along
 * the grid to its repo's tower each time something real happens in the task
 * (see `use-data-packets.ts`). This module is the pure part: which events send
 * one, the throttle, and the path.
 */

/** What a packet stands for; styles.css colours `.bw-packet[data-kind]` by it. */
export type PacketKind = "step" | "commit" | "finding" | "check-pass" | "check-fail";

/** At most one packet per task this often. */
export const PACKET_TASK_GAP_MS = 2000;
/** At most this many packets on screen at once. */
export const PACKET_MAX_IN_FLIGHT = 6;
/** Dot to tower; the `.bw-packet-core` fade delay (1100ms) in styles.css. */
export const PACKET_TRAVEL_MS = 1100;
/** The fade at the tower; the `.bw-packet-core` fade duration (300ms) in styles.css. */
export const PACKET_FADE_MS = 300;
/** A packet is dropped this long after it starts. */
export const PACKET_MS = PACKET_TRAVEL_MS + PACKET_FADE_MS;
/** Dedupe keys kept; the oldest go first. */
export const PACKET_SEEN_CAP = 500;
/** A finding created at most this long ago counts as new. */
export const PACKET_FINDING_FRESH_MS = 30_000;

/** Maps a run or a step to its task; undefined when unknown. */
export interface PacketResolve {
  run(runId: string): string | undefined;
  step(stepId: string): string | undefined;
}

/** The payload of a `check.finished` step event, as far as packets read it. */
function checkPassed(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const { exitCode, timedOut } = payload as { exitCode?: unknown; timedOut?: unknown };
  return exitCode === 0 && timedOut !== true;
}

function remember(seen: Set<string>, key: string): void {
  seen.add(key);
  for (const oldest of seen) {
    if (seen.size <= PACKET_SEEN_CAP) break;
    seen.delete(oldest);
  }
}

/**
 * The packet a live server event sends, or null: a step that succeeded, a
 * harness Checks step first seen (the round's commit), a finished check, or a
 * finding created within {@link PACKET_FINDING_FRESH_MS} of `now`. A packet's
 * dedupe key goes into `seen` (capped at {@link PACKET_SEEN_CAP}), so the same
 * thing never fires twice. An event whose task can't be resolved is null.
 */
export function packetFor(
  event: ServerEvent,
  resolve: PacketResolve,
  seen: Set<string>,
  now: number,
): { taskId: string; kind: PacketKind } | null {
  let hit: { taskId: string | undefined; kind: PacketKind; key: string } | null = null;
  switch (event.type) {
    case "step.upserted": {
      const { step } = event.payload;
      if (step.status === "succeeded") {
        hit = { taskId: resolve.run(step.runId), kind: "step", key: `step:${step.id}` };
      } else if (step.agentId === null && step.stage === "checks") {
        // The harness commits the round at the start of Checks.
        hit = { taskId: resolve.run(step.runId), kind: "commit", key: `commit:${step.id}` };
      }
      break;
    }
    case "step.event": {
      const { event: entry } = event.payload;
      if (entry.type !== "check.finished") break;
      hit = {
        taskId: resolve.step(entry.stepId),
        kind: checkPassed(entry.payload) ? "check-pass" : "check-fail",
        key: `check:${entry.stepId}:${entry.seq}`,
      };
      break;
    }
    case "finding.upserted": {
      const { finding } = event.payload;
      // createdAt and updatedAt are separate defaults, so no equality check:
      // an override or merge keeps the original createdAt and falls outside.
      if (now - finding.createdAt.getTime() > PACKET_FINDING_FRESH_MS) break;
      hit = { taskId: finding.taskId, kind: "finding", key: `finding:${finding.id}` };
      break;
    }
    default:
      break;
  }
  if (!hit?.taskId || seen.has(hit.key)) return null;
  remember(seen, hit.key);
  return { taskId: hit.taskId, kind: hit.kind };
}

/**
 * Whether a packet for `taskId` may start at `now` with `inFlight` already on
 * screen: no more than one per task per {@link PACKET_TASK_GAP_MS} and
 * {@link PACKET_MAX_IN_FLIGHT} at once. Records the start when admitted; a
 * rejected packet is dropped, not queued.
 */
export function admitPacket(
  lastByTask: Map<string, number>,
  taskId: string,
  now: number,
  inFlight: number,
): boolean {
  if (inFlight >= PACKET_MAX_IN_FLIGHT) return false;
  const last = lastByTask.get(taskId);
  if (last !== undefined && now - last < PACKET_TASK_GAP_MS) return false;
  lastByTask.set(taskId, now);
  return true;
}

/** A packet's route: offsets from the dot and each leg's share of {@link PACKET_TRAVEL_MS}. */
export interface PacketPath {
  dx: number;
  dy: number;
  xMs: number;
  yMs: number;
}

/**
 * The screen-space L from a dot to its tower: sideways to the tower's x, then
 * up to its base (the horizon). The travel time is split by leg length.
 */
export function packetPath(
  from: { x: number; y: number },
  tower: { x: number; base: number },
): PacketPath {
  const dx = tower.x - from.x;
  const dy = tower.base - from.y;
  const total = Math.abs(dx) + Math.abs(dy);
  const xMs = total === 0 ? 0 : Math.round((PACKET_TRAVEL_MS * Math.abs(dx)) / total);
  return { dx, dy, xMs, yMs: PACKET_TRAVEL_MS - xMs };
}
