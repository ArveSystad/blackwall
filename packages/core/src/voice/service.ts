import { join } from "node:path";
import {
  VOICE_MODEL_IDS,
  VOICE_MODELS,
  VOICE_SAMPLE_RATE,
  type VoiceModelId,
  type VoiceModelSpec,
  type VoiceStatus,
} from "@blackwall/shared";
import { isVoiceModelInstalled } from "./install.js";

/** Voice cannot transcribe: the model is missing or the recognizer does not load. */
export class VoiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceUnavailableError";
  }
}

/** A decoding stream of the sherpa-onnx offline recognizer. */
export interface SpeechStream {
  acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void;
}

/** The parts of sherpa-onnx's offline recognizer voice uses. */
export interface SpeechRecognizer {
  createStream(): SpeechStream;
  decode(stream: SpeechStream): void;
  /** Off the main thread; older builds lack it. */
  decodeAsync?(stream: SpeechStream): Promise<{ text: string }>;
  getResult(stream: SpeechStream): { text: string };
}

/** The parts of `sherpa-onnx-node` voice uses. */
export interface SpeechAddon {
  OfflineRecognizer: new (config: object) => SpeechRecognizer;
}

export interface VoiceServiceOptions {
  /** Where models are unpacked, one folder per archive: `<dataDir>/models`. */
  modelsDir: string;
  /** The chosen model, read at each call (Settings → Voice). */
  modelId: () => VoiceModelId;
  /** Loads the native addon; the default imports `sherpa-onnx-node` on first use. */
  load?: () => Promise<SpeechAddon>;
}

export type VoiceService = ReturnType<typeof createVoiceService>;

async function loadSherpa(): Promise<SpeechAddon> {
  const mod = await import("sherpa-onnx-node");
  return (mod.default ?? mod) as SpeechAddon;
}

/** The sherpa-onnx offline recognizer config for a model in `dir`. */
export function recognizerConfig(spec: VoiceModelSpec, dir: string): object {
  const path = (file: string) => join(dir, file);
  const model =
    spec.kind === "moonshine"
      ? {
          moonshine: {
            preprocessor: path(spec.files.preprocessor),
            encoder: path(spec.files.encoder),
            uncachedDecoder: path(spec.files.uncachedDecoder),
            cachedDecoder: path(spec.files.cachedDecoder),
          },
        }
      : {
          whisper: {
            encoder: path(spec.files.encoder),
            decoder: path(spec.files.decoder),
            // Detects the language.
            language: "",
            task: "transcribe",
          },
        };
  return {
    featConfig: { sampleRate: VOICE_SAMPLE_RATE, featureDim: 80 },
    modelConfig: { ...model, tokens: path(spec.files.tokens), numThreads: 2, provider: "cpu" },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Local speech-to-text with sherpa-onnx. The native addon is imported on first
 * use, and a failure to load is remembered; the recognizer is built once per
 * model. Transcriptions run one at a time. Without the chosen model's files or
 * the addon, voice is unavailable and says why.
 */
export function createVoiceService({ modelsDir, modelId, load = loadSherpa }: VoiceServiceOptions) {
  let addon: Promise<SpeechAddon> | undefined;
  const recognizers = new Map<VoiceModelId, SpeechRecognizer>();
  let queue: Promise<unknown> = Promise.resolve();

  const dirOf = (id: VoiceModelId) => join(modelsDir, VOICE_MODELS[id].archive);

  function loadAddon(): Promise<SpeechAddon> {
    addon ??= load();
    return addon;
  }

  /** Why the model cannot transcribe, or null when it can. */
  async function unavailable(id: VoiceModelId): Promise<string | null> {
    if (!isVoiceModelInstalled(modelsDir, id)) {
      return `Voice model not installed: download it in Settings → Voice or run \`pnpm voice:model ${id}\``;
    }
    try {
      await loadAddon();
    } catch (error) {
      return `Speech recognizer could not load: ${messageOf(error)}`;
    }
    return null;
  }

  async function recognizerFor(id: VoiceModelId): Promise<SpeechRecognizer> {
    const reason = await unavailable(id);
    if (reason) throw new VoiceUnavailableError(reason);
    let recognizer = recognizers.get(id);
    if (!recognizer) {
      const { OfflineRecognizer } = await loadAddon();
      try {
        recognizer = new OfflineRecognizer(recognizerConfig(VOICE_MODELS[id], dirOf(id)));
      } catch (error) {
        throw new VoiceUnavailableError(`Speech recognizer could not load: ${messageOf(error)}`);
      }
      recognizers.set(id, recognizer);
    }
    return recognizer;
  }

  async function transcribeNow(samples: Float32Array): Promise<string> {
    const recognizer = await recognizerFor(modelId());
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: VOICE_SAMPLE_RATE });
    if (recognizer.decodeAsync) return (await recognizer.decodeAsync(stream)).text.trim();
    recognizer.decode(stream);
    return recognizer.getResult(stream).text.trim();
  }

  return {
    /** Whether the chosen model can transcribe, and why not; and which models are installed. */
    async status(): Promise<VoiceStatus> {
      const model = modelId();
      const reason = await unavailable(model);
      const installed = VOICE_MODEL_IDS.filter((id) => isVoiceModelInstalled(modelsDir, id));
      return { available: reason === null, model, reason, installed };
    },

    /**
     * The text spoken in mono samples at {@link VOICE_SAMPLE_RATE}, trimmed.
     * Throws {@link VoiceUnavailableError} when voice is unavailable.
     */
    transcribe(samples: Float32Array): Promise<string> {
      const run = queue.then(() => transcribeNow(samples));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
