import { VOICE_SAMPLE_RATE, type VoiceDraft } from "@blackwall/shared";

/**
 * Mono samples resampled from `fromRate` down to `toRate`: each output sample
 * averages the input samples it covers. The same rate returns the input.
 */
export function downsample(
  input: Float32Array,
  fromRate: number,
  toRate: number = VOICE_SAMPLE_RATE,
): Float32Array {
  if (fromRate === toRate) return input;
  if (fromRate < toRate) throw new Error(`Cannot upsample from ${fromRate} Hz to ${toRate} Hz`);
  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    output[i] = end > start ? sum / (end - start) : 0;
  }
  return output;
}

/** The recorded frames as one buffer, in order. */
export function concatFrames(frames: readonly Float32Array[]): Float32Array {
  const output = new Float32Array(frames.reduce((n, frame) => n + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    output.set(frame, offset);
    offset += frame.length;
  }
  return output;
}

/** The New task form's fields a voice draft fills. */
export function draftFields(draft: Pick<VoiceDraft, "title" | "description">): {
  title: string;
  freeText: string;
} {
  return { title: draft.title, freeText: draft.description };
}
