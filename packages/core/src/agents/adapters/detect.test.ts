import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectCli, parseCliVersion } from "./detect.js";

describe("parseCliVersion", () => {
  it("reads the version from each CLI's --version output", () => {
    expect(parseCliVersion("2.1.294 (Claude Code)\n")).toBe("2.1.294");
    expect(
      parseCliVersion("GitHub Copilot CLI 1.0.93.\nRun 'copilot update' to check for updates.\n"),
    ).toBe("1.0.93");
    expect(parseCliVersion("1.18.30\n")).toBe("1.18.30");
    expect(parseCliVersion("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(parseCliVersion("unknown")).toBeNull();
  });
});

describe("detectCli", () => {
  it("reports an installed CLI and its version", async () => {
    const status = await detectCli("claude", { command: process.execPath });
    expect(status).toEqual({
      cli: "claude",
      installed: true,
      version: process.versions.node,
      error: null,
    });
  });

  it("reports a missing CLI", async () => {
    const status = await detectCli("opencode", { command: "blackwall-no-such-cli" });
    expect(status).toMatchObject({ cli: "opencode", installed: false, version: null });
    expect(status.error).toContain("not found");
  });

  it.skipIf(process.platform !== "win32")("finds a CLI installed as an npm .cmd shim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blackwall-detect-"));
    try {
      const bin = join(dir, "node_modules", "fake", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "fake"), 'console.log("9.8.7");\n');
      writeFileSync(
        join(dir, "fake.cmd"),
        '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\fake\\bin\\fake" %*\r\n',
      );
      // A spread of process.env keeps Windows' `Path`; drop it so only `dir` is searched.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
      );
      const status = await detectCli("opencode", { command: "fake", env: { ...env, PATH: dir } });
      expect(status).toEqual({ cli: "opencode", installed: true, version: "9.8.7", error: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a CLI that fails", async () => {
    const status = await detectCli("claude", {
      command: process.execPath,
      commandArgs: ["-e", "process.exit(2)", "--"],
    });
    expect(status.installed).toBe(false);
    expect(status.error).toBeTruthy();
  });
});
