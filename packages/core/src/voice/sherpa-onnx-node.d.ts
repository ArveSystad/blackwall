// sherpa-onnx-node ships no types: just enough for the offline recognizer voice uses.
declare module "sherpa-onnx-node" {
  interface OfflineStream {
    acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void;
  }

  interface OfflineRecognizerResult {
    text: string;
  }

  class OfflineRecognizer {
    constructor(config: object);
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
    getResult(stream: OfflineStream): OfflineRecognizerResult;
  }

  const sherpa: { OfflineRecognizer: typeof OfflineRecognizer };
  export default sherpa;
  export { OfflineRecognizer };
}
