import type { CiCheck, TaskCi } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { ciSatellite, satelliteChanges, satelliteMap } from "./ci-satellite";
import { makeTask } from "./test-fixtures";

function check(name: string, state: CiCheck["state"]): CiCheck {
  return {
    name,
    kind: "check-run",
    id: name.length,
    state,
    conclusion: state === "failed" ? "failure" : "success",
    url: `https://github.com/acme/web/runs/${name}`,
  };
}

/** A CI watch; checks default to one passing check run. */
function ci(overrides: Partial<TaskCi> = {}): TaskCi {
  return {
    state: "passed",
    sha: "abc1234def5678",
    host: "github.com",
    owner: "acme",
    repo: "web",
    checks: [check("unit", "passed")],
    hint: null,
    startedAt: "2026-10-08T10:00:00.000Z",
    updatedAt: "2026-10-08T10:05:00.000Z",
    finishedAt: "2026-10-08T10:05:00.000Z",
    ...overrides,
  };
}

const pending = () => ci({ state: "pending", finishedAt: null });
const failed = () => ci({ state: "failed", checks: [check("lint", "failed")] });

describe("ciSatellite", () => {
  it("maps a done task's CI to the badge's tone", () => {
    expect(ciSatellite({ status: "done", ci: pending() })).toBe("running");
    expect(ciSatellite({ status: "done", ci: ci() })).toBe("passed");
    expect(ciSatellite({ status: "done", ci: failed() })).toBe("failed");
  });

  it("shows nothing for timed-out, no or unreadable CI", () => {
    expect(ciSatellite({ status: "done", ci: ci({ state: "timed-out" }) })).toBeNull();
    expect(ciSatellite({ status: "done", ci: ci({ state: "none", checks: [] }) })).toBeNull();
    expect(ciSatellite({ status: "done", ci: ci({ state: "unavailable" }) })).toBeNull();
  });

  it("shows nothing without CI", () => {
    expect(ciSatellite({ status: "done", ci: null })).toBeNull();
  });

  it("shows nothing for tasks that are not done", () => {
    for (const status of ["needs-you", "running", "failed"] as const) {
      expect(ciSatellite({ status, ci: failed() })).toBeNull();
    }
  });
});

describe("satelliteChanges", () => {
  it("ignores first sightings", () => {
    const task = makeTask({ status: "done", ci: failed() });
    expect(satelliteChanges(new Map(), [task])).toEqual([]);
  });

  it("reports a running satellite that failed or passed", () => {
    const a = makeTask({ status: "done", ci: pending() });
    const b = makeTask({ status: "done", ci: pending() });
    const prev = satelliteMap([a, b]);
    expect(
      satelliteChanges(prev, [
        { ...a, ci: failed() },
        { ...b, ci: ci() },
      ]),
    ).toEqual([a.id, b.id]);
  });

  it("reports a satellite appearing on a task seen before", () => {
    const task = makeTask({ status: "running" });
    const prev = satelliteMap([task]);
    expect(satelliteChanges(prev, [{ ...task, status: "done", ci: pending() }])).toEqual([task.id]);
  });

  it("ignores an unchanged tone", () => {
    const task = makeTask({ status: "done", ci: pending() });
    expect(satelliteChanges(satelliteMap([task]), [task])).toEqual([]);
  });

  it("ignores a satellite going away", () => {
    const task = makeTask({ status: "done", ci: pending() });
    const prev = satelliteMap([task]);
    expect(satelliteChanges(prev, [{ ...task, ci: ci({ state: "timed-out" }) }])).toEqual([]);
  });

  it("keeps the tasks' order", () => {
    const a = makeTask({ status: "done", ci: pending() });
    const b = makeTask({ status: "done", ci: pending() });
    const prev = satelliteMap([a, b]);
    expect(
      satelliteChanges(prev, [
        { ...b, ci: ci() },
        { ...a, ci: ci() },
      ]),
    ).toEqual([b.id, a.id]);
  });
});
