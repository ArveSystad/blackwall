import { describe, expect, it, vi } from "vitest";
import { createQuitFlow, type QuitFlowDeps, type ShutdownResult } from "./quit-flow.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Lets pending promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(status: number | undefined = 0) {
  const confirms: ReturnType<typeof deferred<boolean>>[] = [];
  const shutdowns: ReturnType<typeof deferred<ShutdownResult>>[] = [];
  const deps = {
    requestStatus: vi.fn(async () => status),
    confirm: vi.fn(() => {
      const answer = deferred<boolean>();
      confirms.push(answer);
      return answer.promise;
    }),
    shutdownChild: vi.fn(() => {
      const result = deferred<ShutdownResult>();
      shutdowns.push(result);
      return result.promise;
    }),
    kill: vi.fn(),
    quit: vi.fn(),
  } satisfies QuitFlowDeps;
  return { deps, flow: createQuitFlow(deps), confirms, shutdowns };
}

describe("createQuitFlow", () => {
  it("prompts with the running agent count", async () => {
    const { deps, flow } = setup(2);
    void flow.request();
    await flush();
    expect(deps.requestStatus).toHaveBeenCalledWith(1000);
    expect(deps.confirm).toHaveBeenCalledWith({
      message: "Are you sure you want to quit blackwall?",
      detail: "There are 2 agents currently running that will be stopped.",
    });
  });

  it("prompts without a detail when the status request times out", async () => {
    const { deps, flow } = setup(undefined);
    void flow.request();
    await flush();
    expect(deps.confirm).toHaveBeenCalledWith({
      message: "Are you sure you want to quit blackwall?",
    });
  });

  it("does nothing on cancel and prompts again on the next request", async () => {
    const { deps, flow, confirms } = setup();
    const request = flow.request();
    await flush();
    confirms[0]!.resolve(false);
    await request;
    expect(deps.shutdownChild).not.toHaveBeenCalled();
    expect(deps.quit).not.toHaveBeenCalled();
    expect(flow.stopping).toBe(false);
    expect(flow.quitting).toBe(false);

    void flow.request();
    await flush();
    expect(deps.confirm).toHaveBeenCalledTimes(2);
  });

  it("stops the child on confirm, then quits once", async () => {
    const { deps, flow, confirms, shutdowns } = setup();
    const request = flow.request();
    await flush();
    confirms[0]!.resolve(true);
    await flush();
    expect(deps.shutdownChild).toHaveBeenCalledWith(15000);
    expect(flow.stopping).toBe(true);
    expect(flow.quitting).toBe(false);
    expect(deps.quit).not.toHaveBeenCalled();

    shutdowns[0]!.resolve("stopped");
    await request;
    expect(deps.kill).not.toHaveBeenCalled();
    expect(flow.quitting).toBe(true);
    expect(deps.quit).toHaveBeenCalledTimes(1);
  });

  it("kills the child when the shutdown times out, then quits", async () => {
    const { deps, flow, confirms, shutdowns } = setup();
    const request = flow.request();
    await flush();
    confirms[0]!.resolve(true);
    await flush();
    shutdowns[0]!.resolve("timeout");
    await request;
    expect(deps.kill).toHaveBeenCalledTimes(1);
    expect(deps.kill.mock.invocationCallOrder[0]).toBeLessThan(
      deps.quit.mock.invocationCallOrder[0]!,
    );
  });

  it("shows one prompt for concurrent requests", async () => {
    const { deps, flow } = setup();
    void flow.request();
    void flow.request();
    await flush();
    void flow.request();
    await flush();
    expect(deps.requestStatus).toHaveBeenCalledTimes(1);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
  });

  it("ignores requests while stopping", async () => {
    const { deps, flow, confirms } = setup();
    void flow.request();
    await flush();
    confirms[0]!.resolve(true);
    await flush();
    await flow.request();
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.shutdownChild).toHaveBeenCalledTimes(1);
  });

  it("force skips the prompt and is stopping synchronously", async () => {
    const { deps, flow, shutdowns } = setup();
    const forced = flow.force();
    expect(flow.stopping).toBe(true);
    expect(flow.quitting).toBe(false);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.shutdownChild).toHaveBeenCalledTimes(1);
    shutdowns[0]!.resolve("exited");
    await forced;
    expect(flow.quitting).toBe(true);
    expect(deps.quit).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "force during a prompt shuts down once and ignores the late answer (%s)",
    async (answer) => {
      const { deps, flow, confirms, shutdowns } = setup();
      const request = flow.request();
      await flush();
      const forced = flow.force();
      confirms[0]!.resolve(answer);
      await request;
      expect(flow.stopping).toBe(true);
      expect(deps.shutdownChild).toHaveBeenCalledTimes(1);
      shutdowns[0]!.resolve("stopped");
      await forced;
      expect(deps.quit).toHaveBeenCalledTimes(1);
    },
  );

  it("shuts down once when forced twice", async () => {
    const { deps, flow, shutdowns } = setup();
    const first = flow.force();
    const second = flow.force();
    shutdowns[0]!.resolve("stopped");
    await Promise.all([first, second]);
    expect(deps.shutdownChild).toHaveBeenCalledTimes(1);
    expect(deps.quit).toHaveBeenCalledTimes(1);
  });
});
