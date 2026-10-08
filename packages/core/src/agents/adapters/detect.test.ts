import { describe, expect, it } from "vitest";
import { detectCli, parseCliVersion } from "./detect.js";

describe("parseCliVersion", () => {
  it("reads the version from each CLI's --version output", () => {
    expect(parseCliVersion("2.1.294 (Claude Code)\n")).toBe("2.1.294");
    expect(
      parseCliVersion("GitHub Copilot CLI 1.0.93.\nRun 'copilot update' to check for updates.\n"),
    ).toBe("1.0.93");
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
    const status = await detectCli("copilot", { command: "blackwall-no-such-cli" });
    expect(status).toMatchObject({ cli: "copilot", installed: false, version: null });
    expect(status.error).toContain("not found");
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
