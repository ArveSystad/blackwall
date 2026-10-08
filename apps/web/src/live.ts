import {
  parseServerEvent,
  type ClientEvent,
  type ServerEvent,
  type StepEvent,
  type Task,
} from "@blackwall/shared";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./query";

/** `connecting` before the first open; `reconnecting` after a drop until the next open. */
export type LiveStatus = "connecting" | "open" | "reconnecting";

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;

/** Backoff before reconnect attempt `attempt` (0-based): 0.5 s doubling to a 10 s cap. */
export function reconnectDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

/** The part of `WebSocket` the live socket uses, so tests can pass a fake. */
export interface SocketLike {
  addEventListener(type: "open" | "close", listener: () => void): void;
  addEventListener(type: "message", listener: (message: { data: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface LiveSocketOptions {
  url: string;
  onEvent: (event: ServerEvent) => void;
  onStatus?: (status: LiveStatus) => void;
  /** Called on every open after the first, when events may have been missed. */
  onReconnect?: () => void;
  createSocket?: (url: string) => SocketLike;
}

export interface LiveSocket {
  /** Sends when open; dropped otherwise. */
  send(event: ClientEvent): void;
  /** Closes for good; no further reconnects. */
  close(): void;
}

/**
 * Opens the typed event socket and keeps it open: after a drop it reconnects
 * with exponential backoff. Invalid server messages are dropped.
 */
export function openLiveSocket({
  url,
  onEvent,
  onStatus,
  onReconnect,
  createSocket = (target) => new WebSocket(target),
}: LiveSocketOptions): LiveSocket {
  let socket: SocketLike | null = null;
  let isOpen = false;
  let everOpened = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function connect() {
    const current = createSocket(url);
    socket = current;
    current.addEventListener("open", () => {
      if (socket !== current) return;
      isOpen = true;
      attempt = 0;
      onStatus?.("open");
      if (everOpened) onReconnect?.();
      everOpened = true;
    });
    current.addEventListener("message", (message) => {
      if (socket !== current) return;
      const event = typeof message.data === "string" ? parseServerEvent(message.data) : null;
      if (event) onEvent(event);
    });
    current.addEventListener("close", () => {
      if (socket !== current || closed) return;
      isOpen = false;
      socket = null;
      onStatus?.(everOpened ? "reconnecting" : "connecting");
      timer = setTimeout(connect, reconnectDelay(attempt++));
    });
  }

  onStatus?.("connecting");
  connect();

  return {
    send(event) {
      if (isOpen) socket?.send(JSON.stringify(event));
    },
    close() {
      closed = true;
      clearTimeout(timer);
      socket?.close();
      socket = null;
    },
  };
}

function upsertTask(tasks: Task[] | undefined, task: Task): Task[] | undefined {
  if (!tasks) return tasks;
  const index = tasks.findIndex((t) => t.id === task.id);
  return index === -1 ? [...tasks, task] : tasks.with(index, task);
}

/**
 * Applies a server event to the Query cache: task changes are written in
 * place; everything else invalidates the queries that hold it, so open views
 * refetch. Step output is appended to an already loaded log.
 */
export function applyServerEvent(client: QueryClient, event: ServerEvent): void {
  switch (event.type) {
    case "task.upserted": {
      const { task } = event.payload;
      client.setQueryData<Task[]>(queryKeys.tasks, (tasks) => upsertTask(tasks, task));
      client.setQueryData<Task>(queryKeys.task(task.id), task);
      // A stage or gate change can mean new commits or a new delivery plan.
      void client.invalidateQueries({ queryKey: queryKeys.taskDiffs(task.id) });
      void client.invalidateQueries({ queryKey: queryKeys.taskDelivery(task.id) });
      break;
    }
    case "task.removed": {
      const { taskId } = event.payload;
      client.setQueryData<Task[]>(queryKeys.tasks, (tasks) =>
        tasks?.filter((t) => t.id !== taskId),
      );
      client.removeQueries({ queryKey: queryKeys.task(taskId) });
      break;
    }
    case "run.upserted":
      void client.invalidateQueries({ queryKey: queryKeys.taskRuns(event.payload.run.taskId) });
      break;
    case "step.upserted":
      void client.invalidateQueries({ queryKey: queryKeys.runSteps(event.payload.step.runId) });
      break;
    case "step.event": {
      const { event: entry } = event.payload;
      client.setQueryData<StepEvent[]>(queryKeys.stepEvents(entry.stepId), (log) =>
        log ? [...log, entry] : log,
      );
      break;
    }
    case "finding.upserted":
      void client.invalidateQueries({
        queryKey: queryKeys.taskFindings(event.payload.finding.taskId),
      });
      break;
    case "grill.upserted":
      void client.invalidateQueries({
        queryKey: queryKeys.taskGrill(event.payload.question.taskId),
      });
      break;
    case "pong":
    case "error":
      break;
  }
}
