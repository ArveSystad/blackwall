import { describe, expect, it } from "vitest";
import { concatFrames, downsample, draftFields, pendingVoiceActions } from "./voice";

describe("downsample", () => {
  it("averages each group of samples from 48 kHz to 16 kHz", () => {
    const input = new Float32Array([0, 0.3, 0.6, 1, 1, 1, -0.3, -0.6, -0.9, 0.5]);
    const output = downsample(input, 48000, 16000);
    expect(output).toHaveLength(3);
    expect(output[0]).toBeCloseTo(0.3);
    expect(output[1]).toBeCloseTo(1);
    expect(output[2]).toBeCloseTo(-0.6);
  });

  it("handles a rate that does not divide evenly", () => {
    const output = downsample(new Float32Array(44100).fill(0.5), 44100, 16000);
    expect(output).toHaveLength(16000);
    expect(output.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });

  it("returns the input at the same rate, and refuses to upsample", () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(downsample(input, 16000)).toBe(input);
    expect(() => downsample(input, 8000)).toThrow("Cannot upsample");
  });
});

describe("concatFrames", () => {
  it("joins frames in order", () => {
    const joined = concatFrames([
      new Float32Array([1, 2]),
      new Float32Array([]),
      new Float32Array([3]),
    ]);
    expect(Array.from(joined)).toEqual([1, 2, 3]);
    expect(concatFrames([])).toHaveLength(0);
  });
});

describe("draftFields", () => {
  it("maps a voice draft onto the form's title and description", () => {
    expect(draftFields({ title: "Dark mode", description: "A toggle" })).toEqual({
      title: "Dark mode",
      freeText: "A toggle",
    });
  });
});

describe("pendingVoiceActions", () => {
  const actions = [
    { id: "a1", kind: "select-repo", repoId: "r2" },
    { id: "a2", kind: "open-chat" },
    { id: "a3", kind: "show-grid" },
  ] as const;
  const state = { clientId: "c1", actions: [...actions] };

  it("returns the actions of this client's command in order", () => {
    expect(pendingVoiceActions(state, "c1", new Set())).toEqual(actions);
  });

  it("returns nothing for another client's command", () => {
    expect(pendingVoiceActions(state, "c2", new Set())).toEqual([]);
    expect(pendingVoiceActions({ ...state, clientId: null }, "c1", new Set())).toEqual([]);
  });

  it("skips the actions already applied", () => {
    expect(pendingVoiceActions(state, "c1", new Set(["a1", "a3"]))).toEqual([actions[1]]);
  });
});
