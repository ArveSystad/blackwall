import { PROJECT_RUN_STATUSES, type ProjectRun } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { isRunActive } from "./project-run";
import { reactorSputters, reactorStatusLabel, reactorVisual, runStatusMap } from "./reactor";

function run(overrides: Partial<ProjectRun> = {}): ProjectRun {
  return {
    repoId: "repo-1",
    runId: "run-1",
    status: "running",
    commands: ["pnpm dev"],
    startedAt: new Date("2026-11-06T10:00:00.000Z"),
    endedAt: null,
    error: null,
    ...overrides,
  };
}

describe("reactorVisual", () => {
  it("maps each status to its steady pylon", () => {
    expect(reactorVisual("starting")).toBe("power-up");
    expect(reactorVisual("running")).toBe("hum");
    expect(reactorVisual("stopping")).toBe("power-down");
    expect(reactorVisual("stopped")).toBeNull();
    expect(reactorVisual("exited")).toBeNull();
    expect(reactorVisual("failed")).toBeNull();
  });

  it("shows a pylon exactly while the run is active", () => {
    for (const status of PROJECT_RUN_STATUSES) {
      expect(reactorVisual(status) !== null).toBe(isRunActive(run({ status })));
    }
  });
});

describe("reactorStatusLabel", () => {
  it("labels the active statuses and failed", () => {
    expect(reactorStatusLabel("starting")).toBe("Starting");
    expect(reactorStatusLabel("running")).toBe("Running");
    expect(reactorStatusLabel("stopping")).toBe("Stopping");
    expect(reactorStatusLabel("failed")).toBe("Failed");
  });
});

describe("reactorSputters", () => {
  const snapshot = (...runs: ProjectRun[]) => runStatusMap(runs);

  it("is empty on the first snapshot", () => {
    expect(reactorSputters(new Map(), [run({ status: "failed" })])).toEqual([]);
  });

  it("sputters a run that turned failed", () => {
    expect(reactorSputters(snapshot(run()), [run({ status: "failed" })])).toEqual(["repo-1"]);
    expect(
      reactorSputters(snapshot(run({ status: "starting" })), [run({ status: "failed" })]),
    ).toEqual(["repo-1"]);
  });

  it("does not sputter a run that was already failed", () => {
    expect(
      reactorSputters(snapshot(run({ status: "failed" })), [run({ status: "failed" })]),
    ).toEqual([]);
  });

  it("does not sputter a repo it had not seen", () => {
    expect(
      reactorSputters(snapshot(run({ repoId: "repo-2" })), [run({ status: "failed" })]),
    ).toEqual([]);
  });

  it("sputters a new run that arrives already failed", () => {
    expect(
      reactorSputters(snapshot(run({ status: "failed" })), [
        run({ runId: "run-2", status: "failed" }),
      ]),
    ).toEqual(["repo-1"]);
  });

  it("does not sputter clean exits or stops", () => {
    expect(reactorSputters(snapshot(run()), [run({ status: "exited" })])).toEqual([]);
    expect(
      reactorSputters(snapshot(run({ status: "stopping" })), [run({ status: "stopped" })]),
    ).toEqual([]);
  });
});
