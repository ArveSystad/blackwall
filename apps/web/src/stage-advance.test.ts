import { describe, expect, it } from "vitest";
import { UI_STAGES } from "./inbox";
import { stageAdvanced } from "./stage-advance";

describe("stageAdvanced", () => {
  it("advances on a forward move", () => {
    expect(stageAdvanced(1, 2)).toBe(true);
  });

  it("advances when a stage is skipped", () => {
    expect(stageAdvanced(1, 3)).toBe(true);
  });

  it("does not advance on the same stage (a status-only change)", () => {
    expect(stageAdvanced(2, 2)).toBe(false);
  });

  it("does not advance on a fix round going back", () => {
    expect(stageAdvanced(4, 2)).toBe(false);
  });

  it("does not advance on the first stage", () => {
    expect(stageAdvanced(-1, 0)).toBe(false);
  });

  it("does not advance when the task turns done", () => {
    expect(stageAdvanced(4, UI_STAGES.length)).toBe(false);
  });
});
