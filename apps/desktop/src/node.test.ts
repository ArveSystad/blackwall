import { describe, expect, it } from "vitest";
import { findOnPath, parseNodeMajor } from "./node.js";

describe("parseNodeMajor", () => {
  it("reads the major version", () => {
    expect(parseNodeMajor("v22.11.0")).toBe(22);
    expect(parseNodeMajor("v18.0.0\n")).toBe(18);
  });

  it("is undefined for other output", () => {
    expect(parseNodeMajor("")).toBeUndefined();
    expect(parseNodeMajor("node")).toBeUndefined();
  });
});

describe("findOnPath", () => {
  it("walks PATH in order on POSIX", () => {
    const files = new Set(["/opt/node/bin/node", "/usr/bin/node"]);
    const env = { PATH: "/usr/local/bin:/opt/node/bin:/usr/bin" };
    expect(findOnPath("node", env, "linux", (path) => files.has(path))).toBe("/opt/node/bin/node");
  });

  it("tries the PATHEXT extensions on Windows", () => {
    const files = new Set(["C:\\Program Files\\nodejs\\node.exe"]);
    const env = { Path: "C:\\Windows;C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.CMD" };
    expect(findOnPath("node", env, "win32", (path) => files.has(path))).toBe(
      "C:\\Program Files\\nodejs\\node.exe",
    );
  });

  it("skips an extensionless file on Windows", () => {
    const files = new Set(["C:\\tools\\node"]);
    const env = { Path: "C:\\tools", PATHEXT: ".EXE" };
    expect(findOnPath("node", env, "win32", (path) => files.has(path))).toBeUndefined();
  });

  it("is undefined when nothing matches", () => {
    expect(findOnPath("node", { PATH: "/usr/bin" }, "darwin", () => false)).toBeUndefined();
    expect(findOnPath("node", {}, "linux", () => true)).toBeUndefined();
  });
});
