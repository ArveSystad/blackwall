import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createGitHubClient,
  GitHubError,
  type GitHubCheckRunJson,
  type GitHubCommitStatusJson,
} from "./client.js";
import { ciVerdict, logTail, readCheckLog, readCommitChecks, toCiChecks } from "./ci.js";

const fixtureText = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const fixtureJson = <T>(name: string) => JSON.parse(fixtureText(name)) as T;

const TOKEN = "ghp_secret_token";
const GHE = { baseUrl: "https://acme.ghe.com", token: TOKEN };
const SHA = "9f1c2d3e4b5a69788796a5b4c3d2e1f009182736";
const COMMIT = { owner: "acme", repo: "shop", sha: SHA };
const API = "https://api.acme.ghe.com";

const json = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const refusal = (status: number, headers: Record<string, string> = {}) =>
  json('{"message":"refused"}', status, headers);

const checkRuns = fixtureJson<{ check_runs: GitHubCheckRunJson[] }>("check-runs.json").check_runs;
const statuses = fixtureJson<{ statuses: GitHubCommitStatusJson[] }>(
  "combined-status.json",
).statuses;

/** A check run as GitHub returns it, completed with `success` unless overridden. */
const run = (patch: Partial<GitHubCheckRunJson> = {}): GitHubCheckRunJson => ({
  id: 1,
  name: "job",
  status: "completed",
  conclusion: "success",
  html_url: "https://acme.ghe.com/acme/shop/runs/1",
  details_url: null,
  app: { slug: "github-actions" },
  output: null,
  ...patch,
});

/** A commit status as GitHub returns it. */
const status = (
  state: string,
  patch: Partial<GitHubCommitStatusJson> = {},
): GitHubCommitStatusJson => ({
  id: 9,
  context: "ci/status",
  state,
  description: null,
  target_url: null,
  ...patch,
});

/**
 * A fake GitHub answering by `host + path`; unknown paths get a 404. Responses
 * carry the request's URL as `fetch` gives them, which Octokit's pagination reads.
 */
function gitHub(routes: Record<string, () => Response | Promise<Response>>) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const respond = routes[`${url.host}${url.pathname}`];
    const res = respond ? await respond() : refusal(404);
    return Object.defineProperty(res, "url", { value: String(input) });
  });
}

const CHECK_RUNS = `${API.replace("https://", "")}/repos/acme/shop/commits/${SHA}/check-runs`;
const STATUS = `${API.replace("https://", "")}/repos/acme/shop/commits/${SHA}/status`;
const RUN_PATH = (id: number) => `api.acme.ghe.com/repos/acme/shop/check-runs/${id}`;
const LOGS_PATH = (id: number) => `api.acme.ghe.com/repos/acme/shop/actions/jobs/${id}/logs`;
const LOG_HOST = "logs.example.test/job/28110002";

/** The job log redirect and the log itself, as GitHub serves them. */
const jobLogRoutes = (): Record<string, () => Response> => ({
  [LOGS_PATH(28110002)]: () =>
    new Response(null, {
      status: 302,
      headers: { location: `https://${LOG_HOST}?sig=x` },
    }),
  [LOG_HOST]: () => new Response(fixtureText("job-log.txt")),
});

describe("toCiChecks", () => {
  it("maps the check runs and statuses of the commit", () => {
    expect(toCiChecks(checkRuns, statuses)).toEqual([
      {
        name: "build",
        kind: "check-run",
        id: 28110001,
        state: "passed",
        conclusion: "success",
        url: "https://acme.ghe.com/acme/shop/runs/28110001",
      },
      {
        name: "test",
        kind: "check-run",
        id: 28110002,
        state: "failed",
        conclusion: "failure",
        url: "https://acme.ghe.com/acme/shop/runs/28110002",
      },
      {
        name: "deploy-preview",
        kind: "check-run",
        id: 28110003,
        state: "skipped",
        conclusion: "skipped",
        url: "https://acme.ghe.com/acme/shop/runs/28110003",
      },
      {
        name: "sonar-quality-gate",
        kind: "check-run",
        id: 28110004,
        state: "passed",
        conclusion: "neutral",
        url: "https://acme.ghe.com/acme/shop/runs/28110004",
      },
      {
        name: "lint",
        kind: "check-run",
        id: 28110005,
        state: "pending",
        conclusion: null,
        url: "https://acme.ghe.com/acme/shop/runs/28110005",
      },
      {
        name: "ci/jenkins",
        kind: "status",
        id: 5510001,
        state: "passed",
        conclusion: "success",
        url: "https://jenkins.acme.test/job/shop/214/",
      },
      {
        name: "codecov/patch",
        kind: "status",
        id: 5510002,
        state: "failed",
        conclusion: "failure",
        url: "https://codecov.acme.test/gh/acme/shop/pull/42",
      },
    ]);
  });

  it("uses the details url when a check run has no html url, and null when it has neither", () => {
    const [withDetails, withNothing] = toCiChecks(
      [
        run({ html_url: null, details_url: "https://ci.acme.test/run/1" }),
        run({ id: 2, html_url: null, details_url: null }),
      ],
      [],
    );
    expect(withDetails?.url).toBe("https://ci.acme.test/run/1");
    expect(withNothing?.url).toBeNull();
  });

  it("has no conclusion while a check run is still going, even if one is set", () => {
    const [checkRun] = toCiChecks([run({ status: "in_progress", conclusion: "success" })], []);
    expect(checkRun).toMatchObject({ state: "pending", conclusion: null });
  });

  it("maps queued check runs to pending and each failing conclusion to failed", () => {
    const states = toCiChecks(
      [
        run({ status: "queued", conclusion: null }),
        ...["failure", "timed_out", "cancelled", "action_required", "startup_failure"].map(
          (conclusion, i) => run({ id: 10 + i, conclusion }),
        ),
      ],
      [],
    ).map((c) => [c.state, c.conclusion]);
    expect(states).toEqual([
      ["pending", null],
      ["failed", "failure"],
      ["failed", "timed_out"],
      ["failed", "cancelled"],
      ["failed", "action_required"],
      ["failed", "startup_failure"],
    ]);
  });

  it("maps commit statuses by their state", () => {
    const mapped = toCiChecks(
      [],
      [
        status("pending", { id: 1, context: "a" }),
        status("error", { id: 2, context: "b" }),
        status("success", { id: 3, context: "c" }),
      ],
    );
    expect(mapped.map((c) => [c.name, c.kind, c.state, c.conclusion])).toEqual([
      ["a", "status", "pending", "pending"],
      ["b", "status", "failed", "error"],
      ["c", "status", "passed", "success"],
    ]);
  });
});

describe("ciVerdict", () => {
  const verdict = (runs: GitHubCheckRunJson[] = [], sts: GitHubCommitStatusJson[] = []) =>
    ciVerdict(toCiChecks(runs, sts));

  it("passes when every check succeeded", () => {
    expect(verdict([run({ id: 1 }), run({ id: 2 })])).toBe("passed");
  });

  it("fails on each failing conclusion", () => {
    for (const conclusion of [
      "failure",
      "timed_out",
      "cancelled",
      "action_required",
      "startup_failure",
    ]) {
      expect(verdict([run({ conclusion }), run({ id: 2 })])).toBe("failed");
    }
  });

  it("is pending while any check runs", () => {
    expect(verdict([run({ status: "in_progress", conclusion: null })])).toBe("pending");
    expect(verdict([run({ status: "queued", conclusion: null })])).toBe("pending");
  });

  it("lets a failure win over a pending check", () => {
    expect(
      verdict([
        run({ conclusion: "failure" }),
        run({ id: 2, status: "in_progress", conclusion: null }),
      ]),
    ).toBe("failed");
  });

  it("passes when only skipped and neutral checks remain", () => {
    expect(verdict([run({ conclusion: "skipped" }), run({ id: 2, conclusion: "neutral" })])).toBe(
      "passed",
    );
  });

  it("fails on a failing or errored status and is pending on a pending one", () => {
    expect(verdict([], [status("failure")])).toBe("failed");
    expect(verdict([], [status("error")])).toBe("failed");
    expect(verdict([run()], [status("pending")])).toBe("pending");
    expect(verdict([run()], [status("success")])).toBe("passed");
  });

  it("is none without checks", () => {
    expect(verdict()).toBe("none");
    expect(ciVerdict([])).toBe("none");
  });

  it("does not wait on an empty status list", () => {
    // GitHub's combined `state` reads pending with no statuses; only the list counts.
    expect(
      verdict([run({ conclusion: "success" }), run({ id: 2, conclusion: "skipped" })], []),
    ).toBe("passed");
  });

  it("reads the fixture's mixed commit as failed", () => {
    expect(ciVerdict(toCiChecks(checkRuns, statuses))).toBe("failed");
  });
});

describe("logTail", () => {
  it("strips ANSI colour codes and Actions timestamps from the recorded log", () => {
    const tail = logTail(fixtureText("job-log.txt"));
    expect(tail.startsWith("##[group]Run pnpm exec vitest run\npnpm exec vitest run\n")).toBe(true);
    expect(tail).not.toContain("\u001b");
    expect(tail).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(tail).toContain("AssertionError: expected 10.01 to equal 10.02");
    expect(tail.endsWith("##[error]Process completed with exit code 1.")).toBe(true);
  });

  it("drops trailing blank lines and normalises line endings", () => {
    expect(logTail("a\r\nb\r\n\n\n")).toBe("a\nb");
  });

  it("keeps the last lines, not counting trailing blank lines", () => {
    expect(logTail("1\n2\n3\n4\n5", { lines: 2 })).toBe("4\n5");
    expect(logTail("1\n2\n3\n\n\n", { lines: 2 })).toBe("2\n3");
  });

  it("trims to the last characters", () => {
    expect(logTail("abcdefghij", { chars: 4 })).toBe("ghij");
    expect(logTail("abc", { chars: 4 })).toBe("abc");
  });

  it("removes timestamps with or without fractional seconds, and keeps leading spaces", () => {
    expect(logTail("2026-10-14T10:00:00Z hello\n2026-10-14T10:00:01.5Z   indented")).toBe(
      "hello\n  indented",
    );
  });
});

describe("readCommitChecks", () => {
  const ok = () =>
    gitHub({
      [CHECK_RUNS]: () => json(fixtureText("check-runs.json")),
      [STATUS]: () => json(fixtureText("combined-status.json")),
    });

  it("reads check runs and statuses when both are readable", async () => {
    const result = await readCommitChecks(createGitHubClient(GHE, ok()), COMMIT);
    expect(result.unreadable).toEqual([]);
    expect(result.checks).toEqual(toCiChecks(checkRuns, statuses));
    expect(result.checks).toHaveLength(7);
  });

  it("requests the commit's check runs and status from the API", async () => {
    const fetchImpl = ok();
    await readCommitChecks(createGitHubClient(GHE, fetchImpl), COMMIT);
    const requested = fetchImpl.mock.calls.map(([url]) => {
      const parsed = new URL(String(url));
      return `${parsed.origin}${parsed.pathname}`;
    });
    expect(requested).toEqual([
      `${API}/repos/acme/shop/commits/${SHA}/check-runs`,
      `${API}/repos/acme/shop/commits/${SHA}/status`,
    ]);
  });

  it("reads the statuses when the token cannot read check runs", async () => {
    const fetchImpl = gitHub({
      [CHECK_RUNS]: () => refusal(403),
      [STATUS]: () => json(fixtureText("combined-status.json")),
    });
    const result = await readCommitChecks(createGitHubClient(GHE, fetchImpl), COMMIT);
    expect(result.unreadable).toEqual([{ source: "check-runs", reason: "scope" }]);
    expect(result.checks).toEqual(toCiChecks([], statuses));
  });

  it("reads the check runs when the statuses are not found", async () => {
    const fetchImpl = gitHub({
      [CHECK_RUNS]: () => json(fixtureText("check-runs.json")),
      [STATUS]: () => refusal(404),
    });
    const result = await readCommitChecks(createGitHubClient(GHE, fetchImpl), COMMIT);
    expect(result.unreadable).toEqual([{ source: "statuses", reason: "scope" }]);
    expect(result.checks).toEqual(toCiChecks(checkRuns, []));
  });

  it("reports an SSO refusal as sso and still reads the other source", async () => {
    const sso = { "x-github-sso": "required; url=https://acme.ghe.com/orgs/acme/sso" };
    const fetchImpl = gitHub({
      [CHECK_RUNS]: () => refusal(403, sso),
      [STATUS]: () => json(fixtureText("combined-status.json")),
    });
    const result = await readCommitChecks(createGitHubClient(GHE, fetchImpl), COMMIT);
    expect(result.unreadable).toEqual([{ source: "check-runs", reason: "sso" }]);
    expect(result.checks).toHaveLength(2);

    const statusSso = gitHub({
      [CHECK_RUNS]: () => json(fixtureText("check-runs.json")),
      [STATUS]: () => refusal(403, sso),
    });
    const second = await readCommitChecks(createGitHubClient(GHE, statusSso), COMMIT);
    expect(second.unreadable).toEqual([{ source: "statuses", reason: "sso" }]);
    expect(second.checks).toHaveLength(5);
  });

  it("rethrows a rate limit, on a 403 or a 429", async () => {
    const limited403 = gitHub({
      [CHECK_RUNS]: () => refusal(403, { "x-ratelimit-remaining": "0" }),
      [STATUS]: () => json(fixtureText("combined-status.json")),
    });
    const err403 = await readCommitChecks(createGitHubClient(GHE, limited403), COMMIT).catch(
      (e: unknown) => e,
    );
    expect(err403).toBeInstanceOf(GitHubError);
    expect((err403 as GitHubError).cause).toBe("rate-limited");

    const limited429 = gitHub({
      [CHECK_RUNS]: () => refusal(429, { "retry-after": "30" }),
      [STATUS]: () => json(fixtureText("combined-status.json")),
    });
    const err429 = await readCommitChecks(createGitHubClient(GHE, limited429), COMMIT).catch(
      (e: unknown) => e,
    );
    expect(err429).toBeInstanceOf(GitHubError);
    expect((err429 as GitHubError).cause).toBe("rate-limited");
  });

  it("rethrows a server error", async () => {
    const fetchImpl = gitHub({
      [CHECK_RUNS]: () => refusal(500),
      [STATUS]: () => json(fixtureText("combined-status.json")),
    });
    const error = await readCommitChecks(createGitHubClient(GHE, fetchImpl), COMMIT).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(500);
  });
});

describe("readCheckLog", () => {
  const runRoute = (id: number) => () => json(JSON.stringify(checkRuns.find((r) => r.id === id)));
  const combinedRoute = () => json(fixtureText("combined-status.json"));

  it("returns the cleaned tail of a GitHub Actions job log", async () => {
    const fetchImpl = gitHub({
      [RUN_PATH(28110002)]: runRoute(28110002),
      ...jobLogRoutes(),
    });
    const log = await readCheckLog(createGitHubClient(GHE, fetchImpl), COMMIT, {
      kind: "check-run",
      id: 28110002,
    });
    expect(log).toBe(logTail(fixtureText("job-log.txt")));
    expect(log).toContain("FAIL");
    expect(log).toContain("AssertionError: expected 10.01 to equal 10.02");
    expect(log).not.toContain("\u001b");
    expect(log).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(log?.endsWith("\n")).toBe(false);

    const logCall = fetchImpl.mock.calls.find(([url]) => String(url).includes("logs.example.test"));
    expect(new Headers(logCall?.[1]?.headers).get("authorization")).toBeNull();
  });

  it("falls back to the check run's output when the job log cannot be downloaded", async () => {
    const fetchImpl = gitHub({
      [RUN_PATH(28110002)]: runRoute(28110002),
      [LOGS_PATH(28110002)]: () => refusal(404),
    });
    const log = await readCheckLog(createGitHubClient(GHE, fetchImpl), COMMIT, {
      kind: "check-run",
      id: 28110002,
    });
    expect(log).toBe(
      [
        "1 test failed",
        "1 failing test in src/invoices/totals.test.ts",
        "FAIL src/invoices/totals.test.ts > rounds the VAT once\nAssertionError: expected 10.01 to equal 10.02",
      ].join("\n\n"),
    );
  });

  it("falls back to the output when the log host refuses the download", async () => {
    const fetchImpl = gitHub({
      [RUN_PATH(28110002)]: runRoute(28110002),
      [LOGS_PATH(28110002)]: () =>
        new Response(null, { status: 302, headers: { location: `https://${LOG_HOST}?sig=old` } }),
      [LOG_HOST]: () => new Response("expired", { status: 403 }),
    });
    const log = await readCheckLog(createGitHubClient(GHE, fetchImpl), COMMIT, {
      kind: "check-run",
      id: 28110002,
    });
    expect(log).toContain("1 failing test in src/invoices/totals.test.ts");
  });

  it("returns the output of a check run from another app, without asking for a job log", async () => {
    const fetchImpl = gitHub({ [RUN_PATH(28110004)]: runRoute(28110004) });
    const log = await readCheckLog(createGitHubClient(GHE, fetchImpl), COMMIT, {
      kind: "check-run",
      id: 28110004,
    });
    expect(log).toBe("Quality gate skipped\n\nNo coverage report was uploaded.");
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/actions/jobs/"))).toBe(
      false,
    );
  });

  it("is undefined for a check run with no output", async () => {
    const fetchImpl = gitHub({
      [RUN_PATH(28110003)]: runRoute(28110003),
      [LOGS_PATH(28110003)]: () => refusal(404),
    });
    const log = await readCheckLog(createGitHubClient(GHE, fetchImpl), COMMIT, {
      kind: "check-run",
      id: 28110003,
    });
    expect(log).toBeUndefined();
  });

  it("returns a status's description", async () => {
    const fetchImpl = gitHub({ [STATUS]: combinedRoute });
    const log = await readCheckLog(createGitHubClient(GHE, fetchImpl), COMMIT, {
      kind: "status",
      id: 5510002,
    });
    expect(log).toBe("60% (target 80%)");
  });

  it("is undefined for a status without a description, or one not on the commit", async () => {
    const blank = { ...fixtureJson<Record<string, unknown>>("combined-status.json") };
    blank.statuses = [{ ...statuses[1], description: "   " }];
    const fetchImpl = gitHub({ [STATUS]: () => json(JSON.stringify(blank)) });
    expect(
      await readCheckLog(createGitHubClient(GHE, fetchImpl), COMMIT, {
        kind: "status",
        id: 5510002,
      }),
    ).toBeUndefined();
    expect(
      await readCheckLog(createGitHubClient(GHE, gitHub({ [STATUS]: combinedRoute })), COMMIT, {
        kind: "status",
        id: 1,
      }),
    ).toBeUndefined();
  });

  it("rethrows an abort instead of falling back to the output", async () => {
    const controller = new AbortController();
    const fetchImpl = gitHub({
      [RUN_PATH(28110002)]: runRoute(28110002),
      // The abort lands while the job log is being requested.
      [LOGS_PATH(28110002)]: () => {
        controller.abort();
        return refusal(404);
      },
    });
    await expect(
      readCheckLog(
        createGitHubClient(GHE, fetchImpl),
        COMMIT,
        { kind: "check-run", id: 28110002 },
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});
