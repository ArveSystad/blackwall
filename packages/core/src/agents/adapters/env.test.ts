import { describe, expect, it } from "vitest";
import { mergeEnv, omitEnv } from "./env.js";

describe("mergeEnv", () => {
  it("replaces names that differ only in case on Windows", () => {
    expect(
      mergeEnv(
        { Path: "C:\\old", blackwall_guard_allow: "[]", HOME: "h" },
        { PATH: "C:\\new", BLACKWALL_GUARD_ALLOW: '["git diff"]' },
        "win32",
      ),
    ).toEqual({ PATH: "C:\\new", BLACKWALL_GUARD_ALLOW: '["git diff"]', HOME: "h" });
  });

  it("keeps names that differ in case elsewhere", () => {
    expect(mergeEnv({ Path: "/old", HOME: "h" }, { PATH: "/new" }, "linux")).toEqual({
      Path: "/old",
      PATH: "/new",
      HOME: "h",
    });
  });

  it("does not change the base", () => {
    const base = { A: "1" };
    mergeEnv(base, { A: "2" }, "win32");
    expect(base).toEqual({ A: "1" });
  });
});

describe("omitEnv", () => {
  it("drops names in any case on Windows", () => {
    expect(
      omitEnv({ opencode_config: "x", OPENCODE_CONFIG: "y", B: "b" }, ["OPENCODE_CONFIG"], "win32"),
    ).toEqual({ B: "b" });
  });

  it("drops only the exact name elsewhere", () => {
    expect(
      omitEnv({ opencode_config: "x", OPENCODE_CONFIG: "y", B: "b" }, ["OPENCODE_CONFIG"], "linux"),
    ).toEqual({ opencode_config: "x", B: "b" });
  });
});
