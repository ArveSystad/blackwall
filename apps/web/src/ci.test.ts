import type { CiCheck, TaskCi } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { ciSummary } from "./ci";

const SHA = "abc1234def5678";

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

/** A CI watch on `SHA`; checks default to one passing check run. */
function ci(overrides: Partial<TaskCi> = {}): TaskCi {
  return {
    state: "passed",
    sha: SHA,
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

describe("ciSummary", () => {
  it("reads a running watch as running", () => {
    const summary = ciSummary(ci({ state: "pending", finishedAt: null }));
    expect(summary).toEqual({
      tone: "running",
      label: "CI running",
      title: "Waiting for CI on abc1234",
      failing: [],
    });
  });

  it("reads passed CI as passed", () => {
    const summary = ciSummary(ci());
    expect(summary).toMatchObject({ tone: "passed", label: "CI passed", failing: [] });
    expect(summary.title).toBe("CI passed on abc1234");
  });

  it("names the failing checks in the title and lists them", () => {
    const failing = check("lint", "failed");
    const summary = ciSummary(ci({ state: "failed", checks: [check("unit", "passed"), failing] }));
    expect(summary).toEqual({
      tone: "failed",
      label: "1 check failed",
      title: "CI failed on abc1234: lint",
      failing: [failing],
    });
  });

  it("counts several failing checks", () => {
    const failing = [check("unit", "failed"), check("e2e", "failed")];
    const summary = ciSummary(
      ci({ state: "failed", checks: [...failing, check("lint", "passed")] }),
    );
    expect(summary).toMatchObject({ tone: "failed", label: "2 checks failed", failing });
    expect(summary.title).toBe("CI failed on abc1234: unit, e2e");
  });

  it("reads the other states as muted", () => {
    expect(ciSummary(ci({ state: "timed-out" }))).toMatchObject({
      tone: "muted",
      label: "CI timed out",
    });
    expect(ciSummary(ci({ state: "none", checks: [] }))).toMatchObject({
      tone: "muted",
      label: "No CI",
      title: "No checks ran on abc1234",
    });
    expect(ciSummary(ci({ state: "unavailable" }))).toMatchObject({
      tone: "muted",
      label: "CI unavailable",
      title: "CI on abc1234 can't be read",
    });
  });

  it("adds the hint to the title when there is one", () => {
    const hint = "There is no token for github.com. Add one under Settings → Connections.";
    const summary = ciSummary(ci({ state: "unavailable", hint }));
    expect(summary.title).toBe(`CI on abc1234 can't be read. ${hint}`);
    expect(summary.label).toBe("CI unavailable");
  });
});
