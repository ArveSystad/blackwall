import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PROJECT_OUTPUT_CHARS, type Repo, type ServerEvent } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProjectRuns, type ProjectRuns } from "./project-runs.js";
import { InvalidRepoError, RepoBusyError, RepoNotFoundError } from "./service.js";

let dir: string;
let events: ServerEvent[];
let runs: ProjectRuns;
let repo: Repo;

/** A shell command running `node -e <script>`; the script must not contain double quotes. */
const node = (script: string) => `node -e "${script}"`;
const forever = node("console.log('up'); setInterval(() => {}, 1000)");

function setup(commands: string[], path = dir): void {
  repo = { id: "r1", name: "app", path, runCommands: commands } as Repo;
  runs = createProjectRuns({
    repos: { get: (id) => (id === repo.id ? repo : undefined) },
    publish: (event) => events.push(event),
    graceMs: 200,
    throttleMs: 10,
  });
}

const statuses = () =>
  events.flatMap((e) => (e.type === "projectRun.upserted" ? [e.payload.run.status] : []));
const published = () =>
  events.flatMap((e) => (e.type === "projectRun.output" ? [e.payload.text] : [])).join("");
const status = () => runs.list()[0]?.status;

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const ended = () => until(() => ["stopped", "exited", "failed"].includes(status() ?? ""));

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "blackwall-run-")));
  events = [];
});

afterEach(async () => {
  await runs?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe("createProjectRuns", () => {
  it("starts, turns running after the grace period, streams output and stops", async () => {
    setup([forever]);
    expect(runs.start("r1")).toMatchObject({ repoId: "r1", status: "starting" });
    await until(() => status() === "running");
    await until(() => published().includes("up\n"));
    expect(runs.output("r1")?.text).toContain(`$ ${forever}\nup\n`);
    expect(() => runs.start("r1")).toThrow(RepoBusyError);

    await runs.stop("r1");
    expect(statuses()).toEqual(["starting", "running", "stopping", "stopped"]);
    expect(runs.list()[0]?.endedAt).toBeInstanceOf(Date);
    expect(runs.output("r1")?.text).toMatch(/\[Stopped\]\n$/);
    expect(published()).toBe(runs.output("r1")?.text);
  });

  it("fails when a command exits non-zero and kills its siblings", async () => {
    setup([forever, node("setTimeout(() => process.exit(3), 50)")]);
    runs.start("r1");
    await ended();
    expect(runs.list()[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("exited with code 3"),
    });
    expect(statuses()).toEqual(["starting", "failed"]);
  });

  it("fails after the grace period too", async () => {
    setup([node("setTimeout(() => process.exit(2), 600)")]);
    runs.start("r1");
    await ended();
    expect(statuses()).toEqual(["starting", "running", "failed"]);
  });

  it("ends exited when every command exits 0, prefixing lines per command", async () => {
    setup([node("console.log('one')"), node("console.log('two')")]);
    runs.start("r1");
    await ended();
    expect(status()).toBe("exited");
    const text = runs.output("r1")?.text ?? "";
    expect(text).toContain("[1] one\n");
    expect(text).toContain("[2] two\n");
    expect(text).toMatch(/^\[1\] \$ /);
    expect(text).toMatch(/\[Exited\]\n$/);
  });

  it("strips ANSI codes and turns carriage returns into newlines", async () => {
    setup([node("process.stdout.write('\\u001b[32mgreen\\u001b[0m\\r\\nA\\rB\\n')")]);
    runs.start("r1");
    await ended();
    expect(runs.output("r1")?.text).toContain("green\nA\nB\n");
  });

  it("keeps the tail of long output while counting every character", async () => {
    setup([node(`process.stdout.write('x'.repeat(${MAX_PROJECT_OUTPUT_CHARS * 3}) + 'END')`)]);
    runs.start("r1");
    await ended();
    const output = runs.output("r1");
    expect(output?.text.length).toBe(MAX_PROJECT_OUTPUT_CHARS);
    expect(output?.end).toBeGreaterThan(MAX_PROJECT_OUTPUT_CHARS * 3);
    expect(output?.text).toContain("END");
  });

  it("hides blackwall's tokens from the commands", async () => {
    process.env.BLACKWALL_TOKEN_X = "secret";
    try {
      setup([node("console.log('token=' + (process.env.BLACKWALL_TOKEN_X ?? 'none'))")]);
      runs.start("r1");
      await ended();
    } finally {
      delete process.env.BLACKWALL_TOKEN_X;
    }
    expect(runs.output("r1")?.text).toContain("token=none");
  });

  it("refuses unknown repos, repos without run commands and missing folders", () => {
    setup([]);
    expect(() => runs.start("nope")).toThrow(RepoNotFoundError);
    expect(() => runs.start("r1")).toThrow(InvalidRepoError);
    setup(["echo hi"], join(dir, "gone"));
    expect(() => runs.start("r1")).toThrow(InvalidRepoError);
    expect(runs.output("r1")).toBeNull();
  });

  it("stops every run on shutdown", async () => {
    setup([forever]);
    runs.start("r1");
    await until(() => published().includes("up"));
    await runs.shutdown();
    expect(status()).toBe("stopped");
  });
});
