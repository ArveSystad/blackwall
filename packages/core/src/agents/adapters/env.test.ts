import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { expandEnv, expandEnvValue, mergeEnv, omitEnv, withRepoEnv } from "./env.js";

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

describe("expandEnvValue", () => {
  const home = "/home/me";
  const value = (text: string, env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = "linux") =>
    expandEnvValue(text, env, platform, home).value;

  it("expands a leading ~ only", () => {
    expect(value("~")).toBe(home);
    expect(value("~/x")).toBe(`${home}/x`);
    expect(value("~\\x", {}, "win32")).toBe(`${home}\\x`);
    expect(value("~user")).toBe("~user");
    expect(value("a~")).toBe("a~");
    expect(expandEnvValue("~/x", {}, "linux", home).referenced).toEqual([]);
  });

  it("uses the real home folder by default", () => {
    expect(expandEnvValue("~/x", {}, "linux").value).toBe(`${homedir()}/x`);
  });

  it("expands $VAR and ${VAR}", () => {
    expect(value("$HOME/x", { HOME: "/h" })).toBe("/h/x");
    expect(value("${HOME}x", { HOME: "/h" })).toBe("/hx");
  });

  it("expands %VAR% on Windows only, ignoring case there", () => {
    expect(value("%USERPROFILE%\\x", { USERPROFILE: "C:\\U" }, "win32")).toBe("C:\\U\\x");
    expect(value("%USERPROFILE%\\x", { userprofile: "C:\\U" }, "win32")).toBe("C:\\U\\x");
    expect(value("%ProgramFiles(x86)%", { "ProgramFiles(x86)": "C:\\P" }, "win32")).toBe("C:\\P");
    expect(value("%USERPROFILE%", { USERPROFILE: "C:\\U" }, "linux")).toBe("%USERPROFILE%");
    expect(value("$home", { HOME: "/h" }, "linux")).toBe("");
    expect(value("$home", { HOME: "/h" }, "win32")).toBe("/h");
  });

  it("turns $$ into a literal $", () => {
    expect(expandEnvValue("$$HOME", { HOME: "/h" }, "linux", home)).toEqual({
      value: "$HOME",
      unknown: [],
      referenced: [],
    });
  });

  it("expands unset variables to empty and reports them", () => {
    expect(expandEnvValue("$NOPE/x", {}, "linux", home)).toEqual({
      value: "/x",
      unknown: ["NOPE"],
      referenced: ["NOPE"],
    });
    expect(expandEnvValue("a${EMPTY}b", { EMPTY: "" }, "linux", home)).toEqual({
      value: "ab",
      unknown: [],
      referenced: ["EMPTY"],
    });
  });

  it("lists each referenced name once", () => {
    const expanded = expandEnvValue("$A${B}%C%$A", {}, "win32", home);
    expect(expanded.referenced).toEqual(["A", "B", "C"]);
    expect(expanded.unknown).toEqual(["A", "B", "C"]);
  });

  it("never expands substituted text again", () => {
    expect(value("$A", { A: "$B", B: "no" })).toBe("$B");
  });

  it("keeps anything else as typed", () => {
    expect(value("a $ b")).toBe("a $ b");
    expect(value("$1")).toBe("$1");
    expect(value("${UNTERMINATED")).toBe("${UNTERMINATED");
    expect(value("100%% sure", {}, "win32")).toBe("100%% sure");
    expect(value("plain value")).toBe("plain value");
  });
});

describe("expandEnv", () => {
  it("expands each value and reports per name", () => {
    expect(expandEnv({ A: "$X/a", B: "$NOPE", C: "plain" }, { X: "/x" }, "linux")).toEqual({
      env: { A: "/x/a", B: "", C: "plain" },
      unknown: { B: ["NOPE"] },
      referenced: { A: ["X"], B: ["NOPE"] },
    });
  });
});

describe("withRepoEnv", () => {
  it("expands against the base, then merges case-insensitively on Windows", () => {
    expect(
      withRepoEnv({ Path: "C:\\bin", HOME: "h" }, { PATH: "%path%;C:\\more" }, "win32"),
    ).toEqual({
      PATH: "C:\\bin;C:\\more",
      HOME: "h",
    });
  });
});
