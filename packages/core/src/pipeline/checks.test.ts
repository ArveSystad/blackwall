import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_CHECK_OUTPUT_CHARS, runCheckCommand } from "./checks.js";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "blackwall-checks-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A shell command running `node -e <script>`; the script must not contain double quotes. */
const node = (script: string) => `node -e "${script}"`;

const run = (command: string, timeoutMs?: number, signal = new AbortController().signal) =>
  runCheckCommand(command, { cwd: dir, signal, ...(timeoutMs ? { timeoutMs } : {}) });

describe("runCheckCommand", () => {
  it("passes with exit code 0 and runs in the worktree", async () => {
    const outcome = await run(node("console.log(process.cwd())"));
    expect(outcome).toMatchObject({ exitCode: 0, timedOut: false });
    expect(outcome.output.trim().toLowerCase()).toBe(dir.toLowerCase());
  });

  it("reports the exit code with stdout and stderr", async () => {
    const outcome = await run(
      node("console.log('building'); console.error('TS2322: bad type'); process.exit(2)"),
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.output).toContain("building");
    expect(outcome.output).toContain("TS2322: bad type");
  });

  it("keeps only the tail of long output", async () => {
    const outcome = await run(
      node(`process.stdout.write('x'.repeat(${MAX_CHECK_OUTPUT_CHARS * 3}) + 'END')`),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toMatch(/^\[… \d+ earlier characters cut\]\n/);
    expect(outcome.output.endsWith("END")).toBe(true);
    expect(outcome.output.length).toBeLessThan(MAX_CHECK_OUTPUT_CHARS + 100);
  });

  it("kills a command that runs past its timeout", async () => {
    const outcome = await run(node("setTimeout(() => {}, 60000)"), 300);
    expect(outcome).toMatchObject({ exitCode: null, timedOut: true });
    expect(outcome.output).toContain("Timed out");
  });

  it("kills the command on abort", async () => {
    const controller = new AbortController();
    const pending = run(node("setTimeout(() => {}, 60000)"), undefined, controller.signal);
    setTimeout(() => controller.abort(), 200);
    expect(await pending).toMatchObject({ exitCode: null, timedOut: false });
  });
});
