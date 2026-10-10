import type { StaleRepo } from "@blackwall/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, StaleRepoError, artifactUrl, listConnections, socketUrl } from "./api";

describe("socketUrl", () => {
  it("uses ws: on http", () => {
    expect(socketUrl({ protocol: "http:", host: "127.0.0.1:4711" })).toBe("ws://127.0.0.1:4711/ws");
  });

  it("uses wss: on https", () => {
    expect(socketUrl({ protocol: "https:", host: "localhost:1" })).toBe("wss://localhost:1/ws");
  });
});

describe("artifactUrl", () => {
  it("encodes each path segment, keeps the slashes and versions by modified time", () => {
    const modifiedAt = new Date(1_700_000_000_000);
    expect(artifactUrl("t1", { path: "ui/home page#1.png", modifiedAt })).toBe(
      "/api/tasks/t1/artifacts/ui/home%20page%231.png?v=1700000000000",
    );
  });
});

describe("API errors", () => {
  afterEach(() => vi.unstubAllGlobals());

  function respond(status: number, body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status })),
    );
  }

  it("turns a StaleRepo response into a warning error", async () => {
    const stale: StaleRepo = {
      error: "StaleRepo",
      repoId: "r1",
      name: "app",
      path: "/code/app",
      removed: true,
      message: "app no longer exists at /code/app and was removed from the registry",
    };
    respond(410, stale);
    const error = await listConnections().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StaleRepoError);
    expect(error).toMatchObject({ status: 410, stale, message: stale.message });
  });

  it("uses the server's error text otherwise", async () => {
    respond(410, { error: "Gone" });
    const error = await listConnections().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(StaleRepoError);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("Gone");
  });
});
