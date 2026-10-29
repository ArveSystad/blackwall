import type { StaleRepo } from "@blackwall/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  StaleRepoError,
  artifactUrl,
  deleteMemory,
  downloadVoiceModel,
  getArtifactText,
  listConnections,
  listMemories,
  memoryBackfillStatus,
  sendVoiceCommand,
  socketUrl,
  startMemoryBackfill,
  transcribeVoice,
  updateMemory,
} from "./api";
import { VOICE_CLIENT_ID } from "./voice";

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

describe("getArtifactText", () => {
  afterEach(() => vi.unstubAllGlobals());
  const artifact = { path: "docs/notes.md", modifiedAt: new Date(1_700_000_000_000) };

  it("fetches the artifact's URL and returns its text", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("# Notes"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getArtifactText("t1", artifact)).toBe("# Notes");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/tasks/t1/artifacts/docs/notes.md?v=1700000000000",
    );
  });

  it("throws the server's error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: "Artifact docs/notes.md not found" }), {
          status: 404,
        }),
      ),
    );
    const error = await getArtifactText("t1", artifact).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, message: "Artifact docs/notes.md not found" });
  });
});

describe("request bodies", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends voice samples as raw floats, only the view's own", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ text: "hi" })));
    vi.stubGlobal("fetch", fetch);
    const all = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(await transcribeVoice(all.subarray(1, 4))).toBe("hi");
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/voice/transcribe");
    expect(init?.headers).toEqual({ "content-type": "application/octet-stream" });
    const body = init?.body as ArrayBuffer;
    expect(body.byteLength).toBe(3 * 4);
    expect(Array.from(new Float32Array(body))).toEqual(Array.from(all.subarray(1, 4)));
  });

  it("posts the voice model to download and parses the state", async () => {
    const state = {
      model: "whisper-small",
      phase: "downloading",
      receivedBytes: 0,
      totalBytes: null,
      error: null,
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify(state), { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    expect(await downloadVoiceModel("whisper-small")).toEqual(state);
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/voice/download");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ model: "whisper-small" }));
  });

  it("still sends JSON bodies as JSON", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            busy: true,
            repoId: "r1",
            transcript: "hi",
            activity: null,
            reply: null,
            error: null,
            draft: null,
            created: null,
            clientId: VOICE_CLIENT_ID,
            actions: [],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    await sendVoiceCommand("r1", "hi");
    const [, init] = fetch.mock.calls[0]!;
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(init?.body).toBe(
      JSON.stringify({ repoId: "r1", text: "hi", clientId: VOICE_CLIENT_ID }),
    );

    await sendVoiceCommand("r1", "approve the plan", { taskId: "t1" });
    expect(fetch.mock.calls[1]![1]?.body).toBe(
      JSON.stringify({
        repoId: "r1",
        text: "approve the plan",
        clientId: VOICE_CLIENT_ID,
        taskId: "t1",
      }),
    );
  });

  const memory = {
    id: "m1",
    repoId: "r1",
    sourceTaskId: null,
    kind: "pitfall",
    text: "Run codegen first",
    files: null,
    pinned: false,
    awaitingMerge: false,
    editedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("lists a repo's memories and held notes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          memories: [memory],
          awaitingMerge: [{ ...memory, id: "m2", awaitingMerge: true }],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const { memories, awaitingMerge } = await listMemories("r1");
    expect(fetch.mock.calls[0]![0]).toBe("/api/repos/r1/memories");
    expect(memories[0]).toMatchObject({ id: "m1", createdAt: new Date(memory.createdAt) });
    expect(awaitingMerge.map((m) => m.id)).toEqual(["m2"]);
  });

  it("patches and deletes a memory", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...memory, pinned: true })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    expect((await updateMemory("r1", "m1", { pinned: true })).pinned).toBe(true);
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/repos/r1/memories/m1");
    expect(init?.method).toBe("PATCH");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(init?.body).toBe(JSON.stringify({ pinned: true }));
    await deleteMemory("r1", "m1");
    expect(fetch.mock.calls[1]![0]).toBe("/api/repos/r1/memories/m1");
    expect(fetch.mock.calls[1]![1]?.method).toBe("DELETE");
  });

  it("reads and starts the memory backfill", async () => {
    const status = { running: false, pending: 3, done: 0, saved: 0, skipped: 0, failed: 0 };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(status)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...status, running: true }), { status: 202 }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await memoryBackfillStatus("r1")).toEqual(status);
    expect(fetch.mock.calls[0]![0]).toBe("/api/repos/r1/memories/backfill");
    expect((await startMemoryBackfill("r1")).running).toBe(true);
    const [path, init] = fetch.mock.calls[1]!;
    expect(path).toBe("/api/repos/r1/memories/backfill");
    expect(init?.method).toBe("POST");
  });
});
