import { AGENT_CLIS } from "@blackwall/shared";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLI_CHECK_COMMANDS,
  CLI_CHECK_OUTPUT_LIMIT,
  CLI_CHECK_PROMPT,
  checkCli,
  cleanCheckOutput,
} from "./check.js";
import {
  AgentRunError,
  emptyUsage,
  type AgentAdapter,
  type AgentResult,
  type AgentRunOptions,
} from "./types.js";

const fakeCli = join(fileURLToPath(new URL("./fixtures/", import.meta.url)), "fake-cli.js");

/** An adapter whose run settles with `outcome`, recording the options it got. */
function stubAdapter(outcome: AgentResult | Error): AgentAdapter & { calls: AgentRunOptions[] } {
  const calls: AgentRunOptions[] = [];
  return {
    cli: "claude",
    calls,
    run(options) {
      calls.push(options);
      const result = outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
      result.catch(() => undefined);
      return {
        result,
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          return;
        },
      };
    },
  };
}

describe("checkCli", () => {
  it.each(AGENT_CLIS)("runs each %s check command in order with the repo's env", async (cli) => {
    const result = await checkCli(cli, {
      command: process.execPath,
      commandArgs: [fakeCli, "echo-args"],
      env: { FAKE_CLI_VAR: "repo" },
    });
    expect(result.cli).toBe(cli);
    expect(result.steps.map((s) => s.label)).toEqual(CLI_CHECK_COMMANDS[cli].map((c) => c.label));
    result.steps.forEach((step, i) => {
      const { args } = CLI_CHECK_COMMANDS[cli][i]!;
      expect(step).toMatchObject({ ok: true, exitCode: 0, command: [cli, ...args].join(" ") });
      expect(JSON.parse(step.output)).toEqual({ args, var: "repo" });
    });
  });

  it("marks a step that exits non-zero as failed", async () => {
    const result = await checkCli("claude", {
      command: process.execPath,
      commandArgs: [fakeCli, "echo-args"],
      env: { FAKE_CLI_EXIT: "4" },
    });
    expect(result.steps[0]).toMatchObject({ ok: false, exitCode: 4 });
  });

  it("reports a missing CLI and skips the rest", async () => {
    const result = await checkCli("claude", { command: "blackwall-no-such-cli" });
    expect(result.steps[0]!.ok).toBe(false);
    expect(result.steps[0]!.output).toContain("not found on PATH");
    expect(result.steps[1]).toMatchObject({
      label: "Account",
      ok: false,
      output: "Skipped: the CLI did not start",
    });
  });

  it("fails a step that runs past its timeout", async () => {
    const result = await checkCli("copilot", {
      command: process.execPath,
      commandArgs: [fakeCli, "hang"],
      timeoutMs: 300,
    });
    expect(result.steps[0]).toMatchObject({ ok: false, exitCode: null });
    expect(result.steps[0]!.output).toContain("Timed out");
  });

  it("sends the test prompt read-only with the repo's env and folder", async () => {
    const adapter = stubAdapter({ sessionId: "s", text: "OK", usage: emptyUsage() });
    const result = await checkCli("claude", {
      command: process.execPath,
      commandArgs: [fakeCli, "echo-args"],
      env: { CLAUDE_CONFIG_DIR: "/second" },
      cwd: process.cwd(),
      prompt: adapter,
    });
    expect(result.steps.at(-1)).toMatchObject({ label: "Test prompt", ok: true, output: "OK" });
    const [call] = adapter.calls;
    expect(call).toMatchObject({
      prompt: CLI_CHECK_PROMPT,
      cwd: process.cwd(),
      env: { CLAUDE_CONFIG_DIR: "/second" },
      maxTurns: 1,
    });
    expect(call!.permissions.profile).toBe("read-only");
  });

  it("expands the repo's env for the commands", async () => {
    const result = await checkCli("copilot", {
      command: process.execPath,
      commandArgs: [fakeCli, "echo-args"],
      env: { FAKE_CLI_VAR: "$$lit" },
    });
    expect(JSON.parse(result.steps[0]!.output)).toMatchObject({ var: "$lit" });
    expect(result.env).toEqual([{ name: "FAKE_CLI_VAR", value: "$lit", unknown: [] }]);
  });

  it("reports expanded values and unknown variables, hiding secret names", async () => {
    const result = await checkCli("copilot", {
      command: process.execPath,
      commandArgs: [fakeCli, "echo-args"],
      env: { CLAUDE_CONFIG_DIR: "~/c", API_TOKEN: "$NOPE_X", PLAIN: "as typed" },
    });
    expect(result.env).toEqual([
      { name: "CLAUDE_CONFIG_DIR", value: `${homedir()}/c`, unknown: [] },
      { name: "API_TOKEN", value: null, unknown: ["NOPE_X"] },
    ]);
  });

  it("hides a value that pulls in a secret-looking variable", async () => {
    const previous = process.env.BW_TEST_TOKEN;
    process.env.BW_TEST_TOKEN = "s3cret";
    try {
      const result = await checkCli("copilot", {
        command: process.execPath,
        commandArgs: [fakeCli, "echo-args"],
        env: { GH_CONFIG: "$BW_TEST_TOKEN" },
      });
      expect(result.env).toEqual([{ name: "GH_CONFIG", value: null, unknown: [] }]);
      expect(JSON.stringify(result)).not.toContain("s3cret");
    } finally {
      if (previous === undefined) delete process.env.BW_TEST_TOKEN;
      else process.env.BW_TEST_TOKEN = previous;
    }
  });

  it("fails the test prompt with the CLI's error", async () => {
    const adapter = stubAdapter(
      new AgentRunError("exit", "Claude Code exited with code 1", "not logged in", 1),
    );
    const result = await checkCli("claude", {
      command: process.execPath,
      commandArgs: [fakeCli, "echo-args"],
      prompt: adapter,
    });
    const step = result.steps.at(-1)!;
    expect(step).toMatchObject({ label: "Test prompt", ok: false, exitCode: 1 });
    expect(step.output).toContain("Claude Code exited with code 1");
    expect(step.output).toContain("not logged in");
  });
});

describe("cleanCheckOutput", () => {
  it("strips ANSI escapes and carriage returns", () => {
    expect(cleanCheckOutput("\u001b[32mLogged in\u001b[0m\r\nas me\r\n")).toBe("Logged in\nas me");
  });

  it("caps long output", () => {
    const out = cleanCheckOutput("x".repeat(CLI_CHECK_OUTPUT_LIMIT + 10));
    expect(out.startsWith("x".repeat(CLI_CHECK_OUTPUT_LIMIT))).toBe(true);
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(CLI_CHECK_OUTPUT_LIMIT + 40);
  });
});
