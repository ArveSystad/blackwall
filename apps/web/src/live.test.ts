import type { ServerEvent, StepEvent, Task } from "@blackwall/shared";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyServerEvent,
  openLiveSocket,
  reconnectDelay,
  type LiveStatus,
  type SocketLike,
} from "./live";
import { queryKeys } from "./query";
import { makeTask } from "./test-fixtures";

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, ((message: { data: unknown }) => void)[]>();

  addEventListener(type: string, listener: (message: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: "open" | "close" | "message", data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

describe("reconnectDelay", () => {
  it("doubles from 0.5 s up to a 10 s cap", () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(reconnectDelay)).toEqual([
      500, 1000, 2000, 4000, 8000, 10_000, 10_000,
    ]);
  });
});

describe("openLiveSocket", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function open() {
    const sockets: FakeSocket[] = [];
    const statuses: LiveStatus[] = [];
    const events: ServerEvent[] = [];
    const onReconnect = vi.fn();
    const live = openLiveSocket({
      url: "ws://127.0.0.1:4711/ws",
      onEvent: (event) => events.push(event),
      onStatus: (status) => statuses.push(status),
      onReconnect,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    return { live, sockets, statuses, events, onReconnect };
  }

  it("delivers valid events and drops invalid ones", () => {
    const { sockets, events } = open();
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", JSON.stringify({ type: "task.removed", payload: { taskId: "t" } }));
    sockets[0]!.emit("message", "not json");
    sockets[0]!.emit("message", JSON.stringify({ type: "nope", payload: {} }));
    expect(events).toEqual([{ type: "task.removed", payload: { taskId: "t" } }]);
  });

  it("reconnects with backoff after a drop and reports the reconnect", () => {
    const { sockets, statuses, onReconnect } = open();
    sockets[0]!.emit("open");
    sockets[0]!.emit("close");
    expect(statuses).toEqual(["connecting", "open", "reconnecting"]);

    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    // A failed attempt backs off further.
    sockets[1]!.emit("close");
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    expect(onReconnect).not.toHaveBeenCalled();
    sockets[2]!.emit("open");
    expect(onReconnect).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toBe("open");
  });

  it("sends only while open and stops reconnecting once closed", () => {
    const { live, sockets } = open();
    live.send({ type: "ping", payload: { id: "early" } });
    sockets[0]!.emit("open");
    live.send({ type: "ping", payload: { id: "a" } });
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: "ping", payload: { id: "a" } })]);

    live.close();
    expect(sockets[0]!.closed).toBe(true);
    sockets[0]!.emit("close");
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});

describe("applyServerEvent", () => {
  let client: QueryClient;
  beforeEach(() => {
    client = new QueryClient();
  });

  it("upserts and removes tasks in the list and the task cache", () => {
    const first = makeTask({ title: "First" });
    client.setQueryData<Task[]>(queryKeys.tasks, [first]);

    const changed = { ...first, status: "needs-you" as const };
    applyServerEvent(client, { type: "task.upserted", payload: { task: changed } });
    const added = makeTask({ title: "Second" });
    applyServerEvent(client, { type: "task.upserted", payload: { task: added } });
    expect(client.getQueryData(queryKeys.tasks)).toEqual([changed, added]);
    expect(client.getQueryData(queryKeys.task(first.id))).toEqual(changed);

    applyServerEvent(client, { type: "task.removed", payload: { taskId: first.id } });
    expect(client.getQueryData(queryKeys.tasks)).toEqual([added]);
    expect(client.getQueryData(queryKeys.task(first.id))).toBeUndefined();
  });

  it("leaves an unloaded task list alone", () => {
    applyServerEvent(client, { type: "task.upserted", payload: { task: makeTask() } });
    expect(client.getQueryData(queryKeys.tasks)).toBeUndefined();
  });

  it("invalidates the task's findings, grill and runs", () => {
    for (const key of [
      queryKeys.taskFindings("t1"),
      queryKeys.taskGrill("t1"),
      queryKeys.taskRuns("t1"),
      queryKeys.taskRuns("t2"),
    ]) {
      client.setQueryData(key, []);
    }
    const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;

    applyServerEvent(client, {
      type: "finding.upserted",
      payload: { finding: { taskId: "t1" } as never },
    });
    applyServerEvent(client, {
      type: "grill.upserted",
      payload: { question: { taskId: "t1" } as never },
    });
    applyServerEvent(client, { type: "run.upserted", payload: { run: { taskId: "t1" } as never } });

    expect(stale(queryKeys.taskFindings("t1"))).toBe(true);
    expect(stale(queryKeys.taskGrill("t1"))).toBe(true);
    expect(stale(queryKeys.taskRuns("t1"))).toBe(true);
    expect(stale(queryKeys.taskRuns("t2"))).toBe(false);
  });

  it("appends streamed step output to a loaded log", () => {
    const entry = { stepId: "s1", seq: 1 } as unknown as StepEvent;
    applyServerEvent(client, { type: "step.event", payload: { event: entry } });
    expect(client.getQueryData(queryKeys.stepEvents("s1"))).toBeUndefined();

    client.setQueryData<StepEvent[]>(queryKeys.stepEvents("s1"), []);
    applyServerEvent(client, { type: "step.event", payload: { event: entry } });
    expect(client.getQueryData(queryKeys.stepEvents("s1"))).toEqual([entry]);
  });
});
