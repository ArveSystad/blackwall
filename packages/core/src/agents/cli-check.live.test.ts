import { AGENT_CLIS } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { CLI_CHECK_COMMANDS, checkCli } from "./adapters/check.js";
import { detectCli } from "./adapters/detect.js";

/**
 * The CLI check's commands against the real CLIs: each must finish headless
 * within its timeout (none may wait for a terminal), and the account commands
 * must succeed for a logged-in CLI. Runs only with BLACKWALL_TEST_CLIS=1;
 * CLIs that are not installed are skipped.
 */
describe.runIf(process.env.BLACKWALL_TEST_CLIS === "1")("CLI check commands", () => {
  it.each(AGENT_CLIS)("runs %s's check commands headless", { timeout: 90_000 }, async (cli) => {
    if (!(await detectCli(cli)).installed) return;
    const result = await checkCli(cli);
    expect(result.steps.map((s) => s.label)).toEqual(CLI_CHECK_COMMANDS[cli].map((c) => c.label));
    for (const step of result.steps) {
      expect(step.output, `${step.command}: ${step.output}`).not.toContain("Timed out");
      expect(step.ok, `${step.command}: ${step.output}`).toBe(true);
    }
  });
});
