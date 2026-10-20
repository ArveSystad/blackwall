import {
  RepoNotFoundError,
  VoiceBusyError,
  VoiceDownloadBusyError,
  VoiceDraftConflictError,
  VoiceUnavailableError,
  type VoiceModelDownloads,
  type VoiceService,
} from "@blackwall/core";
import {
  backlogItemSchema,
  voiceDownloadSchema,
  voiceStateSchema,
  voiceStatusSchema,
  type BacklogItem,
  type VoiceDownload,
  type VoiceModelId,
  type VoiceState,
} from "@blackwall/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";
import type { VoiceCommandRouteService } from "./voice.js";

const port = 4711;
const host = `127.0.0.1:${port}`;

const idle: VoiceState = {
  busy: false,
  repoId: null,
  transcript: null,
  activity: null,
  reply: null,
  error: null,
  draft: null,
  created: null,
};

const idleDownload: VoiceDownload = {
  model: null,
  phase: "idle",
  receivedBytes: 0,
  totalBytes: null,
  error: null,
};

const item: BacklogItem = {
  id: "b1",
  repoId: "r1",
  title: "Dark mode",
  origin: { kind: "free-text" },
  mode: null,
  freeText: "A toggle",
  agents: {},
  agentClis: {},
  referenceRepoIds: null,
  triageMode: "intervene",
  position: 0,
  dependsOn: [],
  status: "promoted",
  taskId: "t1",
  sourceTaskId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

let voice: { [K in "status" | "transcribe"]: ReturnType<typeof vi.fn<VoiceService[K]>> };
let downloads: {
  [K in "state" | "start"]: ReturnType<typeof vi.fn<VoiceModelDownloads[K]>>;
};
let commands: {
  [K in keyof VoiceCommandRouteService]: ReturnType<typeof vi.fn<VoiceCommandRouteService[K]>>;
};

beforeEach(() => {
  voice = {
    status: vi.fn(async () => ({
      available: true,
      model: "moonshine-tiny-en",
      reason: null,
      installed: ["moonshine-tiny-en"],
    })),
    transcribe: vi.fn(async () => "create a task"),
  };
  downloads = {
    state: vi.fn(() => idleDownload),
    start: vi.fn((model: VoiceModelId) => {
      if (model === "whisper-small") throw new VoiceDownloadBusyError();
      return { ...idleDownload, model, phase: "downloading" };
    }),
  };
  commands = {
    state: vi.fn(() => idle),
    command: vi.fn((repoId: string, text: string) => {
      if (repoId !== "r1") throw new RepoNotFoundError(repoId);
      if (text === "busy") throw new VoiceBusyError();
      return { ...idle, busy: true, repoId, transcript: text };
    }),
    submitDraft: vi.fn(async (id: string) => {
      if (id !== "d1") throw new VoiceDraftConflictError();
      return item;
    }),
    clearDraft: vi.fn(() => idle),
  };
});

function request(
  path: string,
  init: { method?: string; body?: BodyInit; json?: unknown; type?: string } = {},
  options: { withVoice?: boolean; withDownloads?: boolean } = {},
) {
  const app = createApp({
    token: "test-token",
    getPort: () => port,
    ...(options.withVoice === false ? {} : { voice }),
    voiceCommands: { ...commands, authorize: () => null, callTool: vi.fn() },
    ...(options.withDownloads === false ? {} : { voiceDownloads: downloads }),
  }).app;
  const type = init.type ?? (init.json !== undefined ? "application/json" : undefined);
  return app.request(`http://${host}/api/voice${path}`, {
    method: init.method ?? "GET",
    headers: {
      host,
      cookie: `${tokenCookieName(port)}=test-token`,
      ...(type ? { "content-type": type } : {}),
    },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

const pcm = (samples: number) => new Float32Array(samples).buffer;

describe("voice routes", () => {
  it("reports the status, or unavailable without a voice service", async () => {
    const res = await request("/status");
    expect(voiceStatusSchema.parse(await res.json())).toEqual({
      available: true,
      model: "moonshine-tiny-en",
      reason: null,
      installed: ["moonshine-tiny-en"],
    });
    const none = await request("/status", {}, { withVoice: false });
    expect(await none.json()).toMatchObject({ available: false, installed: [] });
  });

  it("transcribes raw float samples", async () => {
    const samples = new Float32Array([0.5, -0.25, 0.125]);
    const res = await request("/transcribe", {
      method: "POST",
      body: samples.buffer,
      type: "application/octet-stream",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "create a task" });
    expect(Array.from(voice.transcribe.mock.calls[0]![0])).toEqual([0.5, -0.25, 0.125]);
  });

  it("refuses the wrong type, empty or ragged bodies, and clips over the cap", async () => {
    const post = (body: ArrayBuffer, type = "application/octet-stream") =>
      request("/transcribe", { method: "POST", body, type });
    expect((await post(pcm(4), "application/json")).status).toBe(415);
    expect((await post(new ArrayBuffer(0))).status).toBe(400);
    expect((await post(new ArrayBuffer(6))).status).toBe(400);
    expect((await post(pcm(16000 * 30 + 1))).status).toBe(413);
    expect((await post(pcm(16000 * 30))).status).toBe(200);
    expect(voice.transcribe).toHaveBeenCalledTimes(1);
  });

  it("says why voice is unavailable", async () => {
    voice.transcribe.mockRejectedValueOnce(
      new VoiceUnavailableError("Voice model not installed: run `pnpm voice:model x`"),
    );
    const res = await request("/transcribe", {
      method: "POST",
      body: pcm(4),
      type: "application/octet-stream",
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "Voice model not installed: run `pnpm voice:model x`",
    });
    const none = await request(
      "/transcribe",
      { method: "POST", body: pcm(4), type: "application/octet-stream" },
      { withVoice: false },
    );
    expect(none.status).toBe(503);
  });

  it("serves the download state", async () => {
    const res = await request("/download");
    expect(voiceDownloadSchema.parse(await res.json())).toEqual(idleDownload);
  });

  it("starts a download in the background", async () => {
    const res = await request("/download", {
      method: "POST",
      json: { model: "moonshine-tiny-en" },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ model: "moonshine-tiny-en", phase: "downloading" });
    expect(downloads.start).toHaveBeenCalledWith("moonshine-tiny-en");
  });

  it("refuses an unknown model and a download while one runs", async () => {
    const post = (json: unknown) => request("/download", { method: "POST", json });
    expect((await post({ model: "whisper-huge" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    const busy = await post({ model: "whisper-small" });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "A voice model is already downloading" });
    expect(downloads.start).toHaveBeenCalledTimes(1);
  });

  it("leaves the download routes out without downloads", async () => {
    expect((await request("/download", {}, { withDownloads: false })).status).toBe(404);
    const post = await request(
      "/download",
      { method: "POST", json: { model: "moonshine-tiny-en" } },
      { withDownloads: false },
    );
    expect(post.status).toBe(404);
  });

  it("serves the voice state", async () => {
    const res = await request("");
    expect(voiceStateSchema.parse(await res.json())).toEqual(idle);
  });

  it("accepts a command for the background turn", async () => {
    const res = await request("/commands", {
      method: "POST",
      json: { repoId: "r1", text: " create a task " },
    });
    expect(res.status).toBe(202);
    expect(voiceStateSchema.parse(await res.json())).toMatchObject({ busy: true });
    expect(commands.command).toHaveBeenCalledWith("r1", "create a task");
  });

  it("refuses an empty command, an unknown repo and a command while busy", async () => {
    const post = (json: unknown) => request("/commands", { method: "POST", json });
    expect((await post({ repoId: "r1", text: "  " })).status).toBe(400);
    expect((await post({ text: "hi" })).status).toBe(400);
    expect((await post({ repoId: "nope", text: "hi" })).status).toBe(404);
    expect((await post({ repoId: "r1", text: "busy" })).status).toBe(409);
  });

  it("submits a draft from its form, once", async () => {
    const input = { origin: { kind: "free-text" }, title: "Dark mode", freeText: "A toggle" };
    const res = await request("/draft/d1/submit", { method: "POST", json: input });
    expect(res.status).toBe(201);
    expect(backlogItemSchema.parse(await res.json())).toEqual(item);
    expect(commands.submitDraft).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ title: "Dark mode", freeText: "A toggle" }),
    );
    const stale = await request("/draft/old/submit", { method: "POST", json: input });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "The task draft was already created or closed" });
    const invalid = await request("/draft/d1/submit", {
      method: "POST",
      json: { origin: { kind: "free-text" }, freeText: "" },
    });
    expect(invalid.status).toBe(400);
  });

  it("closes a draft", async () => {
    const res = await request("/draft/d1", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(commands.clearDraft).toHaveBeenCalledWith("d1");
  });

  it("needs the launch token", async () => {
    const app = createApp({ token: "test-token", getPort: () => port, voice }).app;
    const res = await app.request(`http://${host}/api/voice/status`, { headers: { host } });
    expect(res.status).toBe(401);
  });
});
