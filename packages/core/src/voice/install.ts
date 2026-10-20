// The single install path for speech models: Settings → Voice runs it through the server
// (`POST /api/voice/download`), and `pnpm voice:model` loads this file from `packages/core/dist`.
// Imports only Node built-ins and `@blackwall/shared`, so the CLI loads nothing else of core.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  VOICE_MODEL_RELEASES,
  VOICE_MODELS,
  type ServerEvent,
  type VoiceDownload,
  type VoiceModelId,
} from "@blackwall/shared";

/** How an install moves on: bytes received while downloading, then unpacking. */
export type VoiceInstallProgress =
  | { phase: "downloading"; receivedBytes: number; totalBytes: number | null }
  | { phase: "unpacking" };

export interface InstallVoiceModelOptions {
  /** Where models are unpacked, one folder per archive: `<dataDir>/models`. */
  modelsDir: string;
  id: VoiceModelId;
  /** Fetches the archive; the default is the global `fetch`. */
  fetch?: (url: string, init: { signal?: AbortSignal }) => Promise<Response>;
  /** Unpacks `file` inside `cwd`; the default is {@link unpackArchive}. */
  unpack?: (file: string, cwd: string, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (progress: VoiceInstallProgress) => void;
}

/** The release URL of a model's archive. */
export function voiceModelUrl(id: VoiceModelId): string {
  return `${VOICE_MODEL_RELEASES}/${VOICE_MODELS[id].archive}.tar.bz2`;
}

/** Whether every file the model needs is in `<modelsDir>/<archive>`; a bare folder is not enough. */
export function isVoiceModelInstalled(modelsDir: string, id: VoiceModelId): boolean {
  const dir = join(modelsDir, VOICE_MODELS[id].archive);
  const files: string[] = Object.values(VOICE_MODELS[id].files);
  return files.every((file) => existsSync(join(dir, file)));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Unpacks a `.tar.bz2` with `tar -xjf`, without blocking the event loop.
 * `file` is relative to `cwd`: GNU tar reads `C:\…` as a remote host. Rejects
 * with tar's stderr when it fails, or the spawn error when it does not start.
 */
export function unpackArchive(
  file: string,
  cwd: string,
  signal?: AbortSignal,
  command = "tar",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["-xjf", file], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      ...(signal ? { signal } : {}),
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `tar exited with code ${code}`));
    });
  });
}

/**
 * Downloads a model's archive and unpacks it into `<modelsDir>/<archive>`.
 * Works in a fresh temp folder, removed afterwards, so a failure leaves no
 * half-installed model; a failed copy into place removes the target too.
 * Skips a model whose files are all there.
 */
export async function installVoiceModel({
  modelsDir,
  id,
  fetch = globalThis.fetch,
  unpack = unpackArchive,
  signal,
  onProgress,
}: InstallVoiceModelOptions): Promise<"installed" | "already-installed"> {
  if (isVoiceModelInstalled(modelsDir, id)) return "already-installed";
  const archive = VOICE_MODELS[id].archive;
  const url = voiceModelUrl(id);
  const file = `${archive}.tar.bz2`;
  const temp = await mkdtemp(join(tmpdir(), "blackwall-voice-"));
  try {
    const res = await fetch(url, signal ? { signal } : {});
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
    const length = Number(res.headers.get("content-length"));
    const totalBytes = Number.isFinite(length) && length > 0 ? length : null;
    let receivedBytes = 0;
    onProgress?.({ phase: "downloading", receivedBytes, totalBytes });
    const count = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        receivedBytes += chunk.length;
        onProgress?.({ phase: "downloading", receivedBytes, totalBytes });
        done(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream),
      count,
      createWriteStream(join(temp, file)),
      signal ? { signal } : {},
    );

    onProgress?.({ phase: "unpacking" });
    const hint = "Unpacking needs tar with bzip2 support; on Linux, install bzip2 and try again.";
    try {
      await unpack(file, temp, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`Could not unpack ${file}: ${messageOf(error)}. ${hint}`, {
        cause: error,
      });
    }
    if (!existsSync(join(temp, archive))) {
      throw new Error(`Could not unpack ${file}: it held no ${archive} folder. ${hint}`);
    }

    const target = join(modelsDir, archive);
    await mkdir(modelsDir, { recursive: true });
    try {
      await cp(join(temp, archive), target, { recursive: true });
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
    return "installed";
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** A download started while another runs. Maps to 409. */
export class VoiceDownloadBusyError extends Error {
  constructor() {
    super("A voice model is already downloading");
    this.name = "VoiceDownloadBusyError";
  }
}

/** The least time between two `voice.download` events while bytes arrive, in ms. */
const PROGRESS_INTERVAL_MS = 250;

const IDLE: VoiceDownload = {
  model: null,
  phase: "idle",
  receivedBytes: 0,
  totalBytes: null,
  error: null,
};

export interface VoiceModelDownloadsOptions {
  /** Where models are unpacked: the voice service's `modelsDir`. */
  modelsDir: string;
  publish: (event: ServerEvent) => void;
  /** Installs a model; the default is {@link installVoiceModel}. */
  install?: (options: InstallVoiceModelOptions) => Promise<unknown>;
  /** The clock progress is throttled by. */
  now?: () => number;
}

export type VoiceModelDownloads = ReturnType<typeof createVoiceModelDownloads>;

/**
 * Speech model downloads from Settings → Voice, one at a time, in the
 * background. The state lives in memory and every change is published as
 * `voice.download`: each phase, and the bytes received at most every
 * {@link PROGRESS_INTERVAL_MS}.
 */
export function createVoiceModelDownloads({
  modelsDir,
  publish,
  install = installVoiceModel,
  now = Date.now,
}: VoiceModelDownloadsOptions) {
  let state: VoiceDownload = IDLE;
  let controller: AbortController | null = null;
  let running: Promise<void> = Promise.resolve();
  let publishedAt = 0;

  function update(patch: Partial<VoiceDownload>, throttle = false): void {
    state = { ...state, ...patch };
    if (throttle && now() - publishedAt < PROGRESS_INTERVAL_MS) return;
    publishedAt = now();
    publish({ type: "voice.download", payload: { download: state } });
  }

  return {
    state(): VoiceDownload {
      return state;
    },

    /**
     * Starts downloading a model and returns at once. Throws
     * {@link VoiceDownloadBusyError} while a download runs.
     */
    start(id: VoiceModelId): VoiceDownload {
      if (controller) throw new VoiceDownloadBusyError();
      const current = new AbortController();
      controller = current;
      update({ model: id, phase: "downloading", receivedBytes: 0, totalBytes: null, error: null });
      running = install({
        modelsDir,
        id,
        signal: current.signal,
        onProgress: (progress) => {
          if (progress.phase === "unpacking") update({ phase: "unpacking" });
          else update(progress, true);
        },
      }).then(
        () => {
          controller = null;
          update({ phase: "done" });
        },
        (error: unknown) => {
          controller = null;
          const message = current.signal.aborted ? "The download was cancelled" : messageOf(error);
          update({ phase: "failed", error: message });
        },
      );
      return state;
    },

    /** Aborts the download in flight; resolves once it has stopped. */
    shutdown(): Promise<void> {
      controller?.abort();
      return running;
    },
  };
}
