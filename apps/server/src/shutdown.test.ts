import { describe, expect, it, vi } from "vitest";
import { createShutdown } from "./shutdown.js";

describe("createShutdown", () => {
  it("runs hooks once, in reverse order, despite failures", async () => {
    const calls: string[] = [];
    const log = vi.fn();
    const shutdown = createShutdown(log);
    shutdown.onShutdown(() => void calls.push("first"));
    shutdown.onShutdown(() => {
      throw new Error("boom");
    });
    shutdown.onShutdown(async () => void calls.push("last"));

    await Promise.all([shutdown.run(), shutdown.run()]);
    expect(calls).toEqual(["last", "first"]);
    expect(log).toHaveBeenCalledOnce();
  });

  it("skips unregistered hooks", async () => {
    const hook = vi.fn();
    const shutdown = createShutdown();
    shutdown.onShutdown(hook)();
    await shutdown.run();
    expect(hook).not.toHaveBeenCalled();
  });
});
