import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { VOICE_MODELS } from "../packages/shared/src/domain.ts";
import { ensureBuilt } from "./start.js";
import { ARCHIVES, DEFAULT_MODEL, modelDirFor } from "./voice-model.js";

vi.mock("./start.js", () => ({ ensureBuilt: vi.fn() }));

describe("importing the script", () => {
  it("neither builds nor loads core's dist; only running it does", () => {
    // The install code is imported dynamically in `main`, so these tests need no build.
    expect(ensureBuilt).not.toHaveBeenCalled();
  });
});

describe("modelDirFor", () => {
  it("unpacks into the data dir's models folder", () => {
    expect(modelDirFor({}, "/home/me", "moonshine-tiny-en")).toBe(
      join("/home/me", ".blackwall", "models", "sherpa-onnx-moonshine-tiny-en-int8"),
    );
  });

  it("honours BLACKWALL_HOME", () => {
    expect(modelDirFor({ BLACKWALL_HOME: "/data/bw" }, "/home/me", "whisper-small")).toBe(
      join("/data/bw", "models", "sherpa-onnx-whisper-small"),
    );
  });

  it("rejects an unknown model, listing the valid ones", () => {
    expect(() => modelDirFor({}, "/home/me", "whisper-huge")).toThrow(
      'Unknown voice model "whisper-huge". Pick one of: moonshine-tiny-en, whisper-small',
    );
  });
});

describe("ARCHIVES", () => {
  it("matches the model catalog", () => {
    expect(ARCHIVES).toEqual(
      Object.fromEntries(Object.entries(VOICE_MODELS).map(([id, m]) => [id, m.archive])),
    );
    expect(DEFAULT_MODEL).toBe("moonshine-tiny-en");
  });
});
