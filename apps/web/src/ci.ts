import type { CiCheck, TaskCi } from "@blackwall/shared";

/** How the CI badge reads: cyan while running, green when passed, red when failed, grey otherwise. */
export type CiTone = "running" | "passed" | "failed" | "muted";

export interface CiSummary {
  tone: CiTone;
  /** "CI running", "CI passed", "2 checks failed", "CI timed out", "No CI", "CI unavailable". */
  label: string;
  /** Tooltip: the commit, the failing checks and the hint, if any. */
  title: string;
  failing: CiCheck[];
}

/** How the task's CI reads in its badge, tooltip and the Finish panel. */
export function ciSummary(ci: TaskCi): CiSummary {
  const failing = ci.checks.filter((c) => c.state === "failed");
  const sha = ci.sha.slice(0, 7);
  const { tone, label, detail } = ((): { tone: CiTone; label: string; detail: string } => {
    switch (ci.state) {
      case "pending":
        return { tone: "running", label: "CI running", detail: `Waiting for CI on ${sha}` };
      case "passed":
        return { tone: "passed", label: "CI passed", detail: `CI passed on ${sha}` };
      case "failed":
        return {
          tone: "failed",
          label: `${failing.length} ${failing.length === 1 ? "check" : "checks"} failed`,
          detail: `CI failed on ${sha}: ${failing.map((c) => c.name).join(", ")}`,
        };
      case "timed-out":
        return {
          tone: "muted",
          label: "CI timed out",
          detail: `CI on ${sha} was still running after an hour`,
        };
      case "none":
        return { tone: "muted", label: "No CI", detail: `No checks ran on ${sha}` };
      case "unavailable":
        return { tone: "muted", label: "CI unavailable", detail: `CI on ${sha} can't be read` };
    }
  })();
  return { tone, label, title: ci.hint ? `${detail}. ${ci.hint}` : detail, failing };
}
