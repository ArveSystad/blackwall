import { describe, expect, it } from "vitest";
import { childEnv } from "./child.js";

describe("childEnv", () => {
  it("drops the browser-mode ports and Electron variables, keeping the rest", () => {
    const env = {
      PATH: "/usr/bin",
      BLACKWALL_HOME: "/data/blackwall",
      BLACKWALL_PORT: "xyz",
      BLACKWALL_WEB_PORT: "abc",
      ELECTRON_RUN_AS_NODE: "1",
    };
    const copy = { ...env };
    expect(childEnv(env)).toEqual({ PATH: "/usr/bin", BLACKWALL_HOME: "/data/blackwall" });
    expect(env).toEqual(copy);
  });
});
