import type { CiCheck } from "@blackwall/shared";
import {
  GitHubError,
  type GitHubCheckRunJson,
  type GitHubClient,
  type GitHubCommitStatusJson,
} from "./client.js";

/** Check run conclusions that fail CI. */
const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

/** Commit status states that fail CI. */
const FAILED_STATUSES = new Set(["failure", "error"]);

function checkRunState(run: GitHubCheckRunJson): CiCheck["state"] {
  if (run.status !== "completed") return "pending";
  const conclusion = run.conclusion ?? "";
  if (FAILED_CONCLUSIONS.has(conclusion)) return "failed";
  return conclusion === "skipped" ? "skipped" : "passed";
}

function statusState(status: GitHubCommitStatusJson): CiCheck["state"] {
  if (FAILED_STATUSES.has(status.state)) return "failed";
  return status.state === "pending" ? "pending" : "passed";
}

/** A commit's check runs and statuses as one list of checks. */
export function toCiChecks(
  checkRuns: readonly GitHubCheckRunJson[],
  statuses: readonly GitHubCommitStatusJson[],
): CiCheck[] {
  return [
    ...checkRuns.map((run): CiCheck => ({
      name: run.name,
      kind: "check-run",
      id: run.id,
      state: checkRunState(run),
      conclusion: run.status === "completed" ? (run.conclusion ?? null) : null,
      url: run.html_url ?? run.details_url ?? null,
    })),
    ...statuses.map((status): CiCheck => ({
      name: status.context,
      kind: "status",
      id: status.id,
      state: statusState(status),
      conclusion: status.state,
      url: status.target_url ?? null,
    })),
  ];
}

/**
 * Where the checks stand: `failed` once any check failed, `pending` while any
 * still runs, `passed` otherwise (skipped and neutral count as passed), and
 * `none` when there are no checks.
 */
export function ciVerdict(checks: readonly CiCheck[]): "failed" | "pending" | "passed" | "none" {
  if (checks.length === 0) return "none";
  if (checks.some((c) => c.state === "failed")) return "failed";
  if (checks.some((c) => c.state === "pending")) return "pending";
  return "passed";
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
/** The timestamp GitHub Actions puts before each log line. */
const ACTIONS_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

/**
 * The end of a log: at most `lines` lines and `chars` characters, without
 * ANSI colour codes, the Actions timestamps and trailing blank lines.
 */
export function logTail(
  text: string,
  { lines = 150, chars = 12_000 }: { lines?: number; chars?: number } = {},
): string {
  const cleaned = text
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.replace(ACTIONS_TIMESTAMP, "").trimEnd());
  while (cleaned.length > 0 && cleaned.at(-1) === "") cleaned.pop();
  const tail = cleaned.slice(-lines).join("\n");
  return tail.length > chars ? tail.slice(-chars) : tail;
}

/** A pushed commit in a GitHub/GHE repository. */
export interface CommitTarget {
  owner: string;
  repo: string;
  sha: string;
}

/** A source of checks the token can't read, and why. */
export interface UnreadableCiSource {
  source: "check-runs" | "statuses";
  /** `sso`: the token isn't authorised for SAML SSO. `scope`: it lacks the permission. */
  reason: "scope" | "sso";
}

export interface CommitChecks {
  checks: CiCheck[];
  unreadable: UnreadableCiSource[];
}

/**
 * Reads the commit's check runs and statuses. A source the token can't read
 * (SSO, or any other 401/403/404) is reported as unreadable and the other is
 * still read. Rate limits and every other failure are rethrown.
 */
export async function readCommitChecks(
  client: Pick<GitHubClient, "listCheckRuns" | "getCombinedStatus">,
  { owner, repo, sha }: CommitTarget,
  signal?: AbortSignal,
): Promise<CommitChecks> {
  const unreadable: UnreadableCiSource[] = [];
  async function read<T>(source: UnreadableCiSource["source"], run: () => Promise<T>) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof GitHubError) || error.cause === "rate-limited") throw error;
      if (error.cause === "sso") {
        unreadable.push({ source, reason: "sso" });
        return undefined;
      }
      if (error.status === 401 || error.status === 403 || error.status === 404) {
        unreadable.push({ source, reason: "scope" });
        return undefined;
      }
      throw error;
    }
  }
  const commit = { owner, repo, ref: sha };
  const checkRuns = await read("check-runs", () => client.listCheckRuns(commit, signal));
  const combined = await read("statuses", () => client.getCombinedStatus(commit, signal));
  return { checks: toCiChecks(checkRuns ?? [], combined?.statuses ?? []), unreadable };
}

/**
 * The end of a failing check's log, for a fix round: the job log of a GitHub
 * Actions check run, else the check run's output, or a status's description.
 * Undefined when there is nothing to show.
 */
export async function readCheckLog(
  client: Pick<GitHubClient, "getCheckRun" | "getJobLogs" | "getCombinedStatus">,
  { owner, repo, sha }: CommitTarget,
  check: Pick<CiCheck, "kind" | "id">,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (check.kind === "status") {
    const combined = await client.getCombinedStatus({ owner, repo, ref: sha }, signal);
    const description = combined.statuses.find((s) => s.id === check.id)?.description?.trim();
    return description || undefined;
  }
  const run = await client.getCheckRun({ owner, repo, id: check.id }, signal);
  if (run.app?.slug === "github-actions") {
    try {
      // For GitHub Actions the check run id is the job id.
      const tail = logTail(await client.getJobLogs({ owner, repo, jobId: check.id }, signal));
      if (tail) return tail;
    } catch (error) {
      if (signal?.aborted) throw error;
      // Fall back to the check run's output.
    }
  }
  const output = [run.output?.title, run.output?.summary, run.output?.text]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join("\n\n");
  return output ? logTail(output) : undefined;
}
