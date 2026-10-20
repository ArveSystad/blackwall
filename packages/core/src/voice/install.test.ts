import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VOICE_MODELS, type ServerEvent, type VoiceModelId } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createVoiceModelDownloads,
  installVoiceModel,
  isVoiceModelInstalled,
  unpackArchive,
  VoiceDownloadBusyError,
  voiceModelUrl,
  type InstallVoiceModelOptions,
  type VoiceInstallProgress,
} from "./install.js";

let modelsDir: string;

beforeEach(() => {
  modelsDir = mkdtempSync(join(tmpdir(), "bw-voice-install-"));
});

afterEach(() => rmSync(modelsDir, { recursive: true, force: true }));

const ID: VoiceModelId = "moonshine-tiny-en";
const ARCHIVE = VOICE_MODELS[ID].archive;

/** A fetch answering with `chunks` of bytes and their total as `content-length`. */
function fakeFetch(chunks = [new Uint8Array(3), new Uint8Array(5)], status = 200) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    return new Response(status === 200 ? body : null, {
      status,
      headers: { "content-length": String(length) },
    });
  };
  return { fetch, urls };
}

/** An unpack that writes the model's files into `<cwd>/<archive>`, recording the temp folders. */
function fakeUnpack(id: VoiceModelId = ID) {
  const temps: string[] = [];
  const unpack = async (_file: string, cwd: string) => {
    temps.push(cwd);
    const dir = join(cwd, VOICE_MODELS[id].archive);
    mkdirSync(dir, { recursive: true });
    for (const file of Object.values(VOICE_MODELS[id].files)) writeFileSync(join(dir, file), "x");
  };
  return { unpack, temps };
}

describe("installVoiceModel", () => {
  it("downloads and unpacks the model into its archive folder, reporting progress", async () => {
    const { fetch, urls } = fakeFetch();
    const { unpack, temps } = fakeUnpack();
    const progress: VoiceInstallProgress[] = [];
    const result = await installVoiceModel({
      modelsDir,
      id: ID,
      fetch,
      unpack,
      onProgress: (p) => progress.push(p),
    });
    expect(result).toBe("installed");
    expect(urls).toEqual([voiceModelUrl(ID)]);
    expect(voiceModelUrl(ID)).toBe(
      `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${ARCHIVE}.tar.bz2`,
    );
    expect(isVoiceModelInstalled(modelsDir, ID)).toBe(true);
    expect(readdirSync(modelsDir)).toEqual([ARCHIVE]);
    expect(progress).toEqual([
      { phase: "downloading", receivedBytes: 0, totalBytes: 8 },
      { phase: "downloading", receivedBytes: 3, totalBytes: 8 },
      { phase: "downloading", receivedBytes: 8, totalBytes: 8 },
      { phase: "unpacking" },
    ]);
    expect(existsSync(temps[0]!)).toBe(false);
  });

  it("skips a fully installed model, but not a folder missing files", async () => {
    const dir = join(modelsDir, ARCHIVE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, VOICE_MODELS[ID].files.tokens), "x");
    expect(isVoiceModelInstalled(modelsDir, ID)).toBe(false);

    const { fetch, urls } = fakeFetch();
    const { unpack } = fakeUnpack();
    expect(await installVoiceModel({ modelsDir, id: ID, fetch, unpack })).toBe("installed");
    expect(urls).toHaveLength(1);
    expect(await installVoiceModel({ modelsDir, id: ID, fetch, unpack })).toBe("already-installed");
    expect(urls).toHaveLength(1);
  });

  it("fails on an HTTP error and leaves no model", async () => {
    const { fetch } = fakeFetch([], 404);
    const { unpack } = fakeUnpack();
    await expect(installVoiceModel({ modelsDir, id: ID, fetch, unpack })).rejects.toThrow(
      `Download failed: HTTP 404 for ${voiceModelUrl(ID)}`,
    );
    expect(existsSync(join(modelsDir, ARCHIVE))).toBe(false);
  });

  it("fails with the bzip2 hint when unpacking fails, leaving no model or temp folder", async () => {
    const { fetch } = fakeFetch();
    const temps: string[] = [];
    const unpack = async (_file: string, cwd: string) => {
      temps.push(cwd);
      throw new Error("bzip2: Cannot exec: No such file or directory");
    };
    await expect(installVoiceModel({ modelsDir, id: ID, fetch, unpack })).rejects.toThrow(
      `Could not unpack ${ARCHIVE}.tar.bz2: bzip2: Cannot exec: No such file or directory. ` +
        "Unpacking needs tar with bzip2 support; on Linux, install bzip2 and try again.",
    );
    expect(existsSync(join(modelsDir, ARCHIVE))).toBe(false);
    expect(existsSync(temps[0]!)).toBe(false);
  });

  it("fails with the hint when the archive holds no model folder", async () => {
    const { fetch } = fakeFetch();
    await expect(
      installVoiceModel({ modelsDir, id: ID, fetch, unpack: async () => undefined }),
    ).rejects.toThrow(/held no .* folder\. Unpacking needs tar with bzip2 support/);
  });
});

describe("unpackArchive", () => {
  it("rejects when tar does not start", async () => {
    await expect(
      unpackArchive("model.tar.bz2", modelsDir, undefined, "blackwall-no-such-tar"),
    ).rejects.toThrow(/ENOENT/);
  });
});

/** An install the test settles by hand, which fails when aborted. */
function manualInstall() {
  const calls: InstallVoiceModelOptions[] = [];
  let settle: { resolve: () => void; reject: (error: Error) => void } | undefined;
  const install = (options: InstallVoiceModelOptions) => {
    calls.push(options);
    return new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  return { install, calls, settle: () => settle! };
}

/** Lets a settled install's handlers run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createVoiceModelDownloads", () => {
  it("runs one download at a time and publishes its phases until done", async () => {
    const events: ServerEvent[] = [];
    const { install, calls, settle } = manualInstall();
    let clock = 0;
    const downloads = createVoiceModelDownloads({
      modelsDir,
      publish: (event) => events.push(event),
      install,
      now: () => clock,
    });
    expect(downloads.state()).toMatchObject({ model: null, phase: "idle" });

    expect(downloads.start("whisper-small")).toMatchObject({
      model: "whisper-small",
      phase: "downloading",
      receivedBytes: 0,
    });
    expect(calls[0]).toMatchObject({ modelsDir, id: "whisper-small" });
    expect(() => downloads.start(ID)).toThrow(VoiceDownloadBusyError);

    clock = 100;
    calls[0]!.onProgress!({ phase: "downloading", receivedBytes: 10, totalBytes: 100 });
    clock = 300;
    calls[0]!.onProgress!({ phase: "downloading", receivedBytes: 50, totalBytes: 100 });
    calls[0]!.onProgress!({ phase: "unpacking" });
    settle().resolve();
    await tick();

    const published = events.map((e) => (e.type === "voice.download" ? e.payload.download : e));
    expect(published).toEqual([
      expect.objectContaining({ phase: "downloading", receivedBytes: 0 }),
      expect.objectContaining({ phase: "downloading", receivedBytes: 50, totalBytes: 100 }),
      expect.objectContaining({ phase: "unpacking" }),
      { model: "whisper-small", phase: "done", receivedBytes: 50, totalBytes: 100, error: null },
    ]);

    // Free again once done.
    downloads.start(ID);
    expect(calls).toHaveLength(2);
  });

  it("ends as failed with the error", async () => {
    const events: ServerEvent[] = [];
    const { install, settle } = manualInstall();
    const downloads = createVoiceModelDownloads({
      modelsDir,
      publish: (event) => events.push(event),
      install,
    });
    downloads.start(ID);
    settle().reject(new Error("Download failed: HTTP 404"));
    await tick();
    expect(downloads.state()).toMatchObject({
      phase: "failed",
      error: "Download failed: HTTP 404",
    });
    expect(events.at(-1)).toEqual({
      type: "voice.download",
      payload: { download: downloads.state() },
    });
  });

  it("aborts the download in flight on shutdown", async () => {
    const { install, calls } = manualInstall();
    const downloads = createVoiceModelDownloads({ modelsDir, publish: () => {}, install });
    downloads.start(ID);
    await downloads.shutdown();
    expect(calls[0]!.signal!.aborted).toBe(true);
    expect(downloads.state()).toMatchObject({
      phase: "failed",
      error: "The download was cancelled",
    });
  });
});
