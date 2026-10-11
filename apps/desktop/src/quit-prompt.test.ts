import { describe, expect, it } from "vitest";
import { quitPrompt } from "./quit-prompt.js";

const message = "Are you sure you want to quit blackwall?";

describe("quitPrompt", () => {
  it("has no detail when the count is unknown or zero", () => {
    expect(quitPrompt(undefined)).toEqual({ message });
    expect(quitPrompt(0)).toEqual({ message });
  });

  it("names the running agents", () => {
    expect(quitPrompt(1)).toEqual({
      message,
      detail: "There is 1 agent currently running that will be stopped.",
    });
    expect(quitPrompt(3)).toEqual({
      message,
      detail: "There are 3 agents currently running that will be stopped.",
    });
  });
});
