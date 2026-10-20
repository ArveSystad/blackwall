import { MAX_VOICE_SECONDS, MIN_VOICE_SECONDS, VOICE_SAMPLE_RATE } from "@blackwall/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { concatFrames, downsample } from "../voice";
import workletUrl from "../voice-recorder.worklet.ts?worker&url";

export type PushToTalkState = "idle" | "starting" | "recording";

interface Recording {
  stream: MediaStream;
  context: AudioContext;
  frames: Float32Array[];
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Hold-to-talk microphone capture. `start` opens the mic (mono, with echo
 * cancellation and noise suppression) and records through an AudioWorklet;
 * `stop` returns the clip as mono samples at {@link VOICE_SAMPLE_RATE}, or
 * null for a clip under {@link MIN_VOICE_SECONDS}. Recording stops by itself
 * at {@link MAX_VOICE_SECONDS}, and `onCapped` gets that clip.
 */
export function usePushToTalk({
  onCapped,
}: {
  onCapped?: (samples: Float32Array | null) => void;
} = {}) {
  const [state, setState] = useState<PushToTalkState>("idle");
  const [error, setError] = useState<string | null>(null);
  const recording = useRef<Recording | null>(null);
  /** Bumped by every start and stop, so a start that finishes after its stop releases the mic. */
  const attempt = useRef(0);
  const onCappedRef = useRef(onCapped);
  useEffect(() => {
    onCappedRef.current = onCapped;
  }, [onCapped]);

  const finish = useCallback((): Float32Array | null => {
    attempt.current += 1;
    const current = recording.current;
    recording.current = null;
    setState("idle");
    if (!current) return null;
    clearTimeout(current.timer);
    for (const track of current.stream.getTracks()) track.stop();
    void current.context.close();
    const samples = downsample(concatFrames(current.frames), current.context.sampleRate);
    return samples.length < MIN_VOICE_SECONDS * VOICE_SAMPLE_RATE ? null : samples;
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (recording.current) return;
    const mine = ++attempt.current;
    setError(null);
    setState("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (cause) {
      if (attempt.current === mine) setState("idle");
      setError(
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Microphone access was denied"
          : "No microphone is available",
      );
      return;
    }
    const context = new AudioContext();
    try {
      // A window without a user gesture (the desktop hotkey from another app) starts suspended.
      if (context.state === "suspended") await context.resume();
      await context.audioWorklet.addModule(workletUrl);
    } catch {
      for (const track of stream.getTracks()) track.stop();
      void context.close();
      if (attempt.current === mine) setState("idle");
      setError("The browser could not start recording");
      return;
    }
    // Released before the mic opened: let it go again.
    if (attempt.current !== mine) {
      for (const track of stream.getTracks()) track.stop();
      void context.close();
      return;
    }
    const frames: Float32Array[] = [];
    const node = new AudioWorkletNode(context, "voice-recorder");
    node.port.onmessage = (event: MessageEvent<Float32Array>) => frames.push(event.data);
    context.createMediaStreamSource(stream).connect(node);
    // Pulled by the destination so it keeps running; it writes no output, so nothing plays.
    node.connect(context.destination);
    const timer = setTimeout(() => onCappedRef.current?.(finish()), MAX_VOICE_SECONDS * 1000);
    recording.current = { stream, context, frames, timer };
    setState("recording");
  }, [finish]);

  // Releases the mic when the component goes away mid-recording.
  useEffect(() => () => void finish(), [finish]);

  return { state, error, start, stop: finish };
}
