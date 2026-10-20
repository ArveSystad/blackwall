// Runs on the audio thread: posts each block of the first channel to the main thread,
// which joins and resamples them on release (see `use-push-to-talk.ts`).

// The AudioWorklet scope is not part of the DOM lib.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class VoiceRecorder extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    // The engine reuses its buffers, so each block is copied.
    if (channel) this.port.postMessage(channel.slice());
    return true;
  }
}

registerProcessor("voice-recorder", VoiceRecorder);

export {};
