import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VOICE_MODELS, type VoiceModelId } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createVoiceService,
  VoiceUnavailableError,
  type SpeechAddon,
  type SpeechRecognizer,
  type SpeechStream,
} from "./service.js";

let modelsDir: string;

beforeEach(() => {
  modelsDir = mkdtempSync(join(tmpdir(), "bw-voice-"));
});

afterEach(() => rmSync(modelsDir, { recursive: true, force: true }));

function install(id: VoiceModelId): string {
  const dir = join(modelsDir, VOICE_MODELS[id].archive);
  mkdirSync(dir, { recursive: true });
  for (const file of Object.values(VOICE_MODELS[id].files)) writeFileSync(join(dir, file), "");
  return dir;
}

interface FakeStream extends SpeechStream {
  waves: { samples: Float32Array; sampleRate: number }[];
}

/** A fake addon recording each recognizer's config and each decoded wave. */
function fakeAddon({
  text = "  open a task  ",
  decode,
}: { text?: string; decode?: (stream: FakeStream) => Promise<{ text: string }> } = {}) {
  const configs: object[] = [];
  const streams: FakeStream[] = [];
  class OfflineRecognizer implements SpeechRecognizer {
    constructor(config: object) {
      configs.push(config);
    }
    createStream(): FakeStream {
      const stream: FakeStream = { waves: [], acceptWaveform: (w) => void stream.waves.push(w) };
      streams.push(stream);
      return stream;
    }
    decode() {}
    async decodeAsync(stream: SpeechStream) {
      return decode ? decode(stream as FakeStream) : { text };
    }
    getResult() {
      return { text };
    }
  }
  const addon: SpeechAddon = { OfflineRecognizer };
  return { addon, configs, streams };
}

describe("voice service", () => {
  it("is unavailable without the chosen model's files, naming the model to download", async () => {
    const { addon } = fakeAddon();
    const voice = createVoiceService({
      modelsDir,
      modelId: () => "whisper-small",
      load: async () => addon,
    });
    expect(await voice.status()).toEqual({
      available: false,
      model: "whisper-small",
      reason: "Voice model not installed: run `pnpm voice:model whisper-small`",
    });
    await expect(voice.transcribe(new Float32Array(16))).rejects.toThrow(VoiceUnavailableError);
    install("whisper-small");
    expect((await voice.status()).available).toBe(true);
  });

  it("is unavailable when the addon does not load, and remembers it", async () => {
    install("moonshine-tiny-en");
    let loads = 0;
    const voice = createVoiceService({
      modelsDir,
      modelId: () => "moonshine-tiny-en",
      load: async () => {
        loads += 1;
        throw new Error("no prebuilt binary for this platform");
      },
    });
    expect(await voice.status()).toEqual({
      available: false,
      model: "moonshine-tiny-en",
      reason: "Speech recognizer could not load: no prebuilt binary for this platform",
    });
    await expect(voice.transcribe(new Float32Array(16))).rejects.toThrow(
      "Speech recognizer could not load",
    );
    expect(loads).toBe(1);
  });

  it("builds Moonshine and Whisper configs from the catalog, once per model", async () => {
    const moonshine = install("moonshine-tiny-en");
    const whisper = install("whisper-small");
    const { addon, configs } = fakeAddon();
    let model: VoiceModelId = "moonshine-tiny-en";
    const voice = createVoiceService({ modelsDir, modelId: () => model, load: async () => addon });

    await voice.transcribe(new Float32Array(16));
    await voice.transcribe(new Float32Array(16));
    expect(configs).toHaveLength(1);
    expect(configs[0]).toEqual({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        moonshine: {
          preprocessor: join(moonshine, "preprocess.onnx"),
          encoder: join(moonshine, "encode.int8.onnx"),
          uncachedDecoder: join(moonshine, "uncached_decode.int8.onnx"),
          cachedDecoder: join(moonshine, "cached_decode.int8.onnx"),
        },
        tokens: join(moonshine, "tokens.txt"),
        numThreads: 2,
        provider: "cpu",
      },
    });

    model = "whisper-small";
    await voice.transcribe(new Float32Array(16));
    expect(configs).toHaveLength(2);
    expect(configs[1]).toMatchObject({
      modelConfig: {
        whisper: {
          encoder: join(whisper, "small-encoder.int8.onnx"),
          decoder: join(whisper, "small-decoder.int8.onnx"),
          language: "",
          task: "transcribe",
        },
        tokens: join(whisper, "small-tokens.txt"),
      },
    });
    model = "moonshine-tiny-en";
    await voice.transcribe(new Float32Array(16));
    expect(configs).toHaveLength(2);
  });

  it("passes the samples at 16 kHz and trims the text", async () => {
    install("moonshine-tiny-en");
    const { addon, streams } = fakeAddon();
    const voice = createVoiceService({
      modelsDir,
      modelId: () => "moonshine-tiny-en",
      load: async () => addon,
    });
    const samples = new Float32Array([0.1, -0.2, 0.3]);
    expect(await voice.transcribe(samples)).toBe("open a task");
    expect(streams[0]?.waves).toEqual([{ samples, sampleRate: 16000 }]);
  });

  it("runs one transcription at a time", async () => {
    install("moonshine-tiny-en");
    let active = 0;
    let most = 0;
    const { addon } = fakeAddon({
      decode: async () => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { text: "hi" };
      },
    });
    const voice = createVoiceService({
      modelsDir,
      modelId: () => "moonshine-tiny-en",
      load: async () => addon,
    });
    const results = await Promise.all([1, 2, 3].map(() => voice.transcribe(new Float32Array(4))));
    expect(results).toEqual(["hi", "hi", "hi"]);
    expect(most).toBe(1);
  });
});
