import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCmdShimTarget, resolveCommand } from "./resolve-command.js";

/** What `npm i -g` writes for a package bin (cmd-shim). */
function npmShim(target: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
    "",
  ].join("\r\n");
}

/** What `pnpm add -g` writes for a package bin. */
function pnpmShim(target: string): string {
  return [
    "@SETLOCAL",
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
    ") ELSE (",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    `  node  "%~dp0\\${target}" %*`,
    ")",
    "",
  ].join("\r\n");
}

let dir: string;

function file(relative: string, content = ""): string {
  const path = join(dir, ...relative.split("\\"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function resolveIn(command: string, env: NodeJS.ProcessEnv = { PATH: dir }) {
  return resolveCommand(command, { platform: "win32", env });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blackwall-resolve-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseCmdShimTarget", () => {
  it("reads the target of npm and pnpm shims", () => {
    expect(parseCmdShimTarget(npmShim("node_modules\\opencode-ai\\bin\\opencode"))).toBe(
      "node_modules\\opencode-ai\\bin\\opencode",
    );
    expect(parseCmdShimTarget(pnpmShim("..\\pnpm\\bin\\pnpm.cjs"))).toBe("..\\pnpm\\bin\\pnpm.cjs");
    expect(parseCmdShimTarget("@echo off\r\nopencode.exe %*\r\n")).toBeUndefined();
  });
});

describe("resolveCommand", () => {
  it("finds an .exe on PATH", () => {
    const exe = file("tool.exe");
    expect(resolveIn("tool")).toEqual({ command: exe, args: [] });
  });

  it("runs the Node script behind an npm shim", () => {
    const target = file("node_modules\\tool\\bin\\tool", "");
    file("tool.cmd", npmShim("node_modules\\tool\\bin\\tool"));
    expect(resolveIn("tool")).toEqual({ command: process.execPath, args: [target] });
  });

  it("runs the Node script behind a pnpm shim", () => {
    const target = file("pkg\\bin\\tool.cjs", "");
    file("bin\\tool.cmd", pnpmShim("..\\pkg\\bin\\tool.cjs"));
    expect(resolveIn("tool", { PATH: join(dir, "bin") })).toEqual({
      command: process.execPath,
      args: [target],
    });
  });

  it("runs the .exe behind a shim directly", () => {
    const exe = file("node_modules\\tool\\bin\\tool.exe");
    file("tool.cmd", npmShim("node_modules\\tool\\bin\\tool.exe"));
    expect(resolveIn("tool")).toEqual({ command: exe, args: [] });
  });

  it("respects PATHEXT order", () => {
    file("node_modules\\tool\\bin\\tool");
    file("tool.cmd", npmShim("node_modules\\tool\\bin\\tool"));
    const exe = file("tool.exe");
    expect(resolveIn("tool")).toEqual({ command: exe, args: [] });
    expect(resolveIn("tool", { PATH: dir, PATHEXT: ".CMD;.EXE" }).command).toBe(process.execPath);
  });

  it("reads Path case-insensitively", () => {
    const exe = file("tool.exe");
    expect(resolveIn("tool", { Path: dir })).toEqual({ command: exe, args: [] });
  });

  it("leaves other commands unchanged", () => {
    file("tool.exe");
    file("broken.cmd", "@echo off\r\nsomething-else %*\r\n");
    file("gone.cmd", npmShim("node_modules\\gone\\bin\\gone"));
    const unchanged = (command: string) => ({ command, args: [] });
    expect(resolveIn("missing")).toEqual(unchanged("missing"));
    expect(resolveIn("broken")).toEqual(unchanged("broken"));
    expect(resolveIn("gone")).toEqual(unchanged("gone"));
    expect(resolveIn("tool.exe")).toEqual(unchanged("tool.exe"));
    expect(resolveIn(join(dir, "tool"))).toEqual(unchanged(join(dir, "tool")));
    expect(resolveCommand("tool", { platform: "linux", env: { PATH: dir } })).toEqual(
      unchanged("tool"),
    );
  });
});
