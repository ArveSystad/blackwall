import type { ServerEvent, Step, StepEvent, StepUsage, Task } from "@blackwall/shared";
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

  it("refetches the deleted task's backlog", () => {
    const task = makeTask({ repoId: "r9" });
    client.setQueryData<Task[]>(queryKeys.tasks, [task]);
    client.setQueryData(queryKeys.backlog("r9"), []);
    applyServerEvent(client, { type: "task.removed", payload: { taskId: task.id } });
    expect(client.getQueryState(queryKeys.backlog("r9"))?.isInvalidated).toBe(true);
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

  it("refetches the delivery plan when findings change, dropping deleted ones at once", () => {
    const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
    client.setQueryData(queryKeys.taskDelivery("t1"), {});
    applyServerEvent(client, {
      type: "finding.upserted",
      payload: { finding: { taskId: "t1" } as never },
    });
    expect(stale(queryKeys.taskDelivery("t1"))).toBe(true);

    client.setQueryData(queryKeys.taskDelivery("t1"), {});
    client.setQueryData(queryKeys.taskFindings("t1"), [{ id: "f1" }, { id: "f2" }, { id: "f3" }]);
    applyServerEvent(client, {
      type: "finding.deleted",
      payload: { taskId: "t1", findingIds: ["f1", "f3"] },
    });
    expect(client.getQueryData(queryKeys.taskFindings("t1"))).toEqual([{ id: "f2" }]);
    expect(stale(queryKeys.taskFindings("t1"))).toBe(true);
    expect(stale(queryKeys.taskDelivery("t1"))).toBe(true);
  });

  it("refetches the active agents when a step changes or a task is removed", () => {
    const stale = () => client.getQueryState(queryKeys.activeAgents)?.isInvalidated;

    client.setQueryData(queryKeys.activeAgents, []);
    applyServerEvent(client, {
      type: "step.upserted",
      payload: { step: { runId: "r1" } as never },
    });
    expect(stale()).toBe(true);

    client.setQueryData(queryKeys.activeAgents, []);
    expect(stale()).toBe(false);
    applyServerEvent(client, { type: "task.removed", payload: { taskId: "t1" } });
    expect(stale()).toBe(true);
  });

  it("refetches the active agents when a sub-agent starts or ends, not on other output", () => {
    const stale = () => client.getQueryState(queryKeys.activeAgents)?.isInvalidated;
    const step = (type: string) =>
      applyServerEvent(client, {
        type: "step.event",
        payload: { event: { stepId: "s1", seq: 1, type } as unknown as StepEvent },
      });

    client.setQueryData(queryKeys.activeAgents, []);
    step("message");
    expect(stale()).toBe(false);
    step("subagent-start");
    expect(stale()).toBe(true);

    client.setQueryData(queryKeys.activeAgents, []);
    step("subagent-end");
    expect(stale()).toBe(true);
  });

  it("refetches a task's artifacts when it changes, and every task's when a step changes", () => {
    const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
    const task = makeTask();
    client.setQueryData(queryKeys.taskArtifacts(task.id), []);
    applyServerEvent(client, { type: "task.upserted", payload: { task } });
    expect(stale(queryKeys.taskArtifacts(task.id))).toBe(true);

    for (const key of [
      queryKeys.taskArtifacts("t1"),
      queryKeys.taskArtifacts("t2"),
      queryKeys.taskDiffs("t1"),
    ]) {
      client.setQueryData(key, []);
    }
    applyServerEvent(client, {
      type: "step.upserted",
      payload: { step: { runId: "r1" } as never },
    });
    expect(stale(queryKeys.taskArtifacts("t1"))).toBe(true);
    expect(stale(queryKeys.taskArtifacts("t2"))).toBe(true);
    expect(stale(queryKeys.taskDiffs("t1"))).toBe(false);
  });

  it("refetches a repo's backlog and runner on backlog.changed, and stores quota", () => {
    for (const key of [
      queryKeys.backlog("r1"),
      queryKeys.backlogRunner("r1"),
      queryKeys.backlog("r2"),
    ]) {
      client.setQueryData(key, []);
    }
    const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
    applyServerEvent(client, { type: "backlog.changed", payload: { repoId: "r1" } });
    expect(stale(queryKeys.backlog("r1"))).toBe(true);
    expect(stale(queryKeys.backlogRunner("r1"))).toBe(true);
    expect(stale(queryKeys.backlog("r2"))).toBe(false);

    const quota = [{ cli: "claude" as const, pausedUntil: new Date("2026-10-08T12:00:00Z") }];
    applyServerEvent(client, { type: "quota.changed", payload: { quota } });
    expect(client.getQueryData(queryKeys.quota)).toEqual(quota);
  });

  it("writes a repo's chat into its query", () => {
    const chat = {
      repoId: "r1",
      taskId: null,
      busy: true,
      activity: "Grep · useTheme",
      messages: [],
    };
    applyServerEvent(client, { type: "chat.upserted", payload: { chat } });
    expect(client.getQueryData(["chat", "r1", null])).toEqual(chat);
    expect(client.getQueryData(queryKeys.chat("r1"))).toEqual(chat);
    expect(client.getQueryData(queryKeys.chat("r2"))).toBeUndefined();
  });

  it("writes a task's chat into its own query, apart from the repo's", () => {
    const chat = { repoId: "r1", taskId: "t1", busy: false, activity: null, messages: [] };
    applyServerEvent(client, { type: "chat.upserted", payload: { chat } });
    expect(client.getQueryData(["chat", "r1", "t1"])).toEqual(chat);
    expect(client.getQueryData(queryKeys.chat("r1"))).toBeUndefined();
    expect(client.getQueryData(queryKeys.chat("r1", "t2"))).toBeUndefined();
  });

  it("writes voice state in place, and refetches what a voice submit created once", () => {
    const voice = {
      busy: true,
      repoId: "r1",
      transcript: "confirm",
      activity: null,
      reply: null,
      error: null,
      draft: null,
      created: null,
      clientId: null,
      actions: [],
    };
    client.setQueryData(queryKeys.tasks, [makeTask({ id: "t1" })]);
    client.setQueryData(queryKeys.backlog("r1"), []);
    applyServerEvent(client, { type: "voice.upserted", payload: { voice } });
    expect(client.getQueryData(queryKeys.voice)).toEqual(voice);
    expect(client.getQueryState(queryKeys.backlog("r1"))?.isInvalidated).toBe(false);
    expect(client.getQueryState(queryKeys.tasks)?.isInvalidated).toBe(false);

    const created = { repoId: "r1", itemId: "b1", taskId: "t2", title: "Dark mode" };
    applyServerEvent(client, { type: "voice.upserted", payload: { voice: { ...voice, created } } });
    expect(client.getQueryData(queryKeys.voice)).toMatchObject({ created });
    expect(client.getQueryState(queryKeys.backlog("r1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.tasks)?.isInvalidated).toBe(true);

    // Later events carrying the same `created` refetch nothing again.
    client.setQueryData(queryKeys.tasks, [makeTask({ id: "t1" })]);
    client.setQueryData(queryKeys.backlog("r1"), []);
    applyServerEvent(client, {
      type: "voice.upserted",
      payload: { voice: { ...voice, busy: false, created } },
    });
    expect(client.getQueryState(queryKeys.backlog("r1"))?.isInvalidated).toBe(false);
    expect(client.getQueryState(queryKeys.tasks)?.isInvalidated).toBe(false);
  });

  it("writes the voice download in place, and rechecks the status once done", () => {
    const status = {
      available: false,
      model: "moonshine-tiny-en" as const,
      reason: "Voice model not installed",
      installed: [],
    };
    const download = {
      model: "moonshine-tiny-en" as const,
      phase: "downloading" as const,
      receivedBytes: 10,
      totalBytes: 100,
      error: null,
    };
    client.setQueryData(queryKeys.voiceStatus, status);
    client.setQueryData(queryKeys.voice, { busy: false });
    applyServerEvent(client, { type: "voice.download", payload: { download } });
    expect(client.getQueryData(queryKeys.voiceDownload)).toEqual(download);
    expect(client.getQueryState(queryKeys.voiceStatus)?.isInvalidated).toBe(false);

    const failed = { ...download, phase: "failed" as const, error: "HTTP 404" };
    applyServerEvent(client, { type: "voice.download", payload: { download: failed } });
    expect(client.getQueryData(queryKeys.voiceDownload)).toEqual(failed);
    expect(client.getQueryState(queryKeys.voiceStatus)?.isInvalidated).toBe(false);

    const done = { ...download, phase: "done" as const };
    applyServerEvent(client, { type: "voice.download", payload: { download: done } });
    expect(client.getQueryState(queryKeys.voiceStatus)?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.voice)?.isInvalidated).toBe(false);
  });

  it("drops every cached query after a data import", () => {
    client.setQueryData(queryKeys.tasks, [makeTask({ id: "t1" })]);
    client.setQueryData(queryKeys.backlog("r1"), []);
    applyServerEvent(client, { type: "data.imported", payload: {} });
    expect(client.getQueryData(queryKeys.tasks)).toBeUndefined();
    expect(client.getQueryData(queryKeys.backlog("r1"))).toBeUndefined();
  });

  it("refetches the repo's backlog when one of its tasks is done", () => {
    client.setQueryData(queryKeys.backlog("r1"), []);
    applyServerEvent(client, {
      type: "task.upserted",
      payload: { task: makeTask({ repoId: "r1", status: "running" }) },
    });
    expect(client.getQueryState(queryKeys.backlog("r1"))?.isInvalidated).toBe(false);
    applyServerEvent(client, {
      type: "task.upserted",
      payload: { task: makeTask({ repoId: "r1", status: "done" }) },
    });
    expect(client.getQueryState(queryKeys.backlog("r1"))?.isInvalidated).toBe(true);
  });

  it("refetches the done times when a task is done or removed", () => {
    const stale = () => client.getQueryState(queryKeys.doneTimes)?.isInvalidated;

    client.setQueryData(queryKeys.doneTimes, []);
    applyServerEvent(client, {
      type: "task.upserted",
      payload: { task: makeTask({ status: "running" }) },
    });
    expect(stale()).toBe(false);
    applyServerEvent(client, {
      type: "task.upserted",
      payload: { task: makeTask({ status: "done" }) },
    });
    expect(stale()).toBe(true);

    client.setQueryData(queryKeys.doneTimes, []);
    expect(stale()).toBe(false);
    applyServerEvent(client, { type: "task.removed", payload: { taskId: "t1" } });
    expect(stale()).toBe(true);
  });

  describe("step usage", () => {
    const step = (overrides: Partial<Step> = {}): Step => ({
      id: "s1",
      runId: "r1",
      stage: "implement",
      agentId: "a1",
      cli: "claude",
      trust: null,
      trustForced: false,
      effort: null,
      round: 0,
      visit: 0,
      status: "running",
      sessionId: null,
      error: null,
      createdAt: new Date("2026-10-14T10:00:00Z"),
      startedAt: new Date("2026-10-14T10:00:00Z"),
      finishedAt: null,
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      costUsd: null,
      ...overrides,
    });
    const row = (stepId: string, outputTokens: number): StepUsage => ({
      taskId: "t1",
      stepId,
      at: new Date("2026-10-14T10:00:00Z"),
      inputTokens: 0,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
    });
    const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;

    it("patches the step and its usage row in place on step.usage, refetching nothing", () => {
      const other = step({ id: "s2" });
      client.setQueryData<Step[]>(queryKeys.runSteps("r1"), [step({ outputTokens: 0 }), other]);
      client.setQueryData<StepUsage[]>(queryKeys.usage, [row("s1", 0), row("s2", 7)]);
      client.setQueryData(queryKeys.activeAgents, []);
      client.setQueryData(queryKeys.taskArtifacts("t1"), []);

      const updated = step({ outputTokens: 50, costUsd: 0.2 });
      applyServerEvent(client, { type: "step.usage", payload: { step: updated } });

      expect(client.getQueryData(queryKeys.runSteps("r1"))).toEqual([updated, other]);
      expect(client.getQueryData(queryKeys.usage)).toEqual([
        {
          ...row("s1", 50),
          inputTokens: 1,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          costUsd: 0.2,
        },
        row("s2", 7),
      ]);
      for (const key of [
        queryKeys.runSteps("r1"),
        queryKeys.usage,
        queryKeys.activeAgents,
        queryKeys.taskArtifacts("t1"),
      ]) {
        expect(stale(key)).toBe(false);
      }
    });

    it("refetches only the usage list for a step it has no row for", () => {
      client.setQueryData<StepUsage[]>(queryKeys.usage, []);
      client.setQueryData(queryKeys.activeAgents, []);
      applyServerEvent(client, { type: "step.usage", payload: { step: step() } });
      expect(stale(queryKeys.usage)).toBe(true);
      expect(stale(queryKeys.activeAgents)).toBe(false);
      expect(client.getQueryData(queryKeys.runSteps("r1"))).toBeUndefined();
    });

    it("patches the usage row on step.upserted and still invalidates as before", () => {
      client.setQueryData<StepUsage[]>(queryKeys.usage, [row("s1", 0)]);
      client.setQueryData(queryKeys.runSteps("r1"), []);
      client.setQueryData(queryKeys.activeAgents, []);
      applyServerEvent(client, {
        type: "step.upserted",
        payload: { step: step({ status: "succeeded", outputTokens: 500, costUsd: 0.05 }) },
      });
      expect(client.getQueryData<StepUsage[]>(queryKeys.usage)?.[0]).toMatchObject({
        outputTokens: 500,
        costUsd: 0.05,
      });
      expect(stale(queryKeys.usage)).toBe(false);
      expect(stale(queryKeys.runSteps("r1"))).toBe(true);
      expect(stale(queryKeys.activeAgents)).toBe(true);
    });

    it("refetches the usage list when a task is removed", () => {
      client.setQueryData<StepUsage[]>(queryKeys.usage, [row("s1", 1)]);
      applyServerEvent(client, { type: "task.removed", payload: { taskId: "t1" } });
      expect(stale(queryKeys.usage)).toBe(true);
    });
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
