import { MAX_PROJECT_OUTPUT_CHARS, type ProjectRun } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { appendProjectOutput, isRunActive, runButtonState } from "./project-run";
import { makeRepo } from "./test-fixtures";

const run = (overrides: Partial<ProjectRun> = {}): ProjectRun => ({
  repoId: "r1",
  runId: "run1",
  status: "running",
  commands: ["pnpm dev"],
  startedAt: new Date(0),
  endedAt: null,
  error: null,
  ...overrides,
});

const repo = makeRepo({ runCommands: ["pnpm dev"] });

describe("runButtonState", () => {
  it("is disabled without run commands or folder", () => {
    expect(runButtonState(makeRepo(), undefined)).toMatchObject({
      disabled: true,
      title: "Add run commands in Settings → Repositories to run this project from here",
      mainLabel: "Run project",
      showOutputButton: false,
    });
    expect(
      runButtonState(makeRepo({ runCommands: ["x"], exists: false }), undefined),
    ).toMatchObject({ disabled: true, title: "The repo folder is missing" });
  });

  it("starts an idle project", () => {
    expect(runButtonState(repo, undefined)).toMatchObject({
      disabled: false,
      mainLabel: "Run project",
      mainAction: "start",
      glowing: false,
      showOutputButton: false,
    });
  });

  it("stops a starting or running project, glowing only once it runs", () => {
    expect(runButtonState(repo, run({ status: "starting" }))).toMatchObject({
      mainLabel: "Stop project",
      mainAction: "stop",
      glowing: false,
      showOutputButton: true,
    });
    expect(runButtonState(repo, run())).toMatchObject({ mainAction: "stop", glowing: true });
    // Run commands removed while it runs: it can still be stopped.
    expect(runButtonState(makeRepo(), run())).toMatchObject({
      disabled: false,
      mainAction: "stop",
    });
  });

  it("waits while stopping", () => {
    expect(runButtonState(repo, run({ status: "stopping" }))).toMatchObject({
      disabled: true,
      mainLabel: "Stopping…",
    });
  });

  it("offers a new run after a failure, with the error as its title", () => {
    const failed = run({ status: "failed", error: "`pnpm dev` exited with code 1" });
    expect(runButtonState(repo, failed)).toMatchObject({
      disabled: false,
      mainLabel: "Run project",
      mainAction: "start",
      title: "`pnpm dev` exited with code 1",
      showOutputButton: true,
    });
    expect(runButtonState(repo, run({ status: "stopped" })).mainAction).toBe("start");
  });
});

describe("isRunActive", () => {
  it("is true while processes may be alive", () => {
    expect(isRunActive(undefined)).toBe(false);
    expect(isRunActive(run({ status: "starting" }))).toBe(true);
    expect(isRunActive(run({ status: "stopping" }))).toBe(true);
    expect(isRunActive(run({ status: "exited" }))).toBe(false);
  });
});

describe("appendProjectOutput", () => {
  const cached = { runId: "run1", end: 3, text: "abc" };

  it("appends a chunk that follows on", () => {
    expect(appendProjectOutput(cached, { runId: "run1", end: 5, text: "de" })).toEqual({
      runId: "run1",
      end: 5,
      text: "abcde",
    });
  });

  it("refuses a gap, another run or nothing cached", () => {
    expect(appendProjectOutput(cached, { runId: "run1", end: 9, text: "de" })).toBeNull();
    expect(appendProjectOutput(cached, { runId: "run2", end: 5, text: "de" })).toBeNull();
    expect(appendProjectOutput(null, { runId: "run1", end: 2, text: "de" })).toBeNull();
  });

  it("keeps only the tail", () => {
    const text = "x".repeat(MAX_PROJECT_OUTPUT_CHARS);
    const next = appendProjectOutput(cached, { runId: "run1", end: 3 + text.length, text });
    expect(next?.text).toHaveLength(MAX_PROJECT_OUTPUT_CHARS);
    expect(next?.end).toBe(3 + MAX_PROJECT_OUTPUT_CHARS);
  });
});
