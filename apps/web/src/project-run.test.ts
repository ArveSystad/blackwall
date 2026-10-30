import { MAX_PROJECT_OUTPUT_CHARS, type ProjectRun } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { appendProjectOutput, isRunActive, outputLinks, runButtonState } from "./project-run";
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

describe("outputLinks", () => {
  const split = (text: string) => {
    const segments = outputLinks(text);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
    return segments;
  };
  const hrefs = (text: string) => split(text).flatMap((segment) => segment.href ?? []);

  it("keeps plain text as one segment", () => {
    expect(split("no links here\n")).toEqual([{ text: "no links here\n" }]);
    expect(split("")).toEqual([]);
  });

  it("links a dev server URL", () => {
    expect(split("  ➜  Local:   http://localhost:5173/\n")).toEqual([
      { text: "  ➜  Local:   " },
      { text: "http://localhost:5173/", href: "http://localhost:5173/" },
      { text: "\n" },
    ]);
  });

  it("links every URL across lines", () => {
    expect(hrefs("Local: http://localhost:3000\nNetwork: https://192.168.1.2:3000/app\n")).toEqual([
      "http://localhost:3000",
      "https://192.168.1.2:3000/app",
    ]);
  });

  it("leaves trailing punctuation out of the link", () => {
    expect(hrefs("See http://x.test/a. Or https://y.test/b, then stop")).toEqual([
      "http://x.test/a",
      "https://y.test/b",
    ]);
  });

  it("leaves out closing brackets the URL didn't open", () => {
    expect(hrefs("(see https://x.test/a)")).toEqual(["https://x.test/a"]);
    expect(hrefs("https://en.wikipedia.org/wiki/A_(b)")).toEqual([
      "https://en.wikipedia.org/wiki/A_(b)",
    ]);
  });

  it("links only http(s) URLs", () => {
    expect(hrefs("ftp://x and http:// and localhost:3000")).toEqual([]);
  });

  it("stops at OSC 8 hyperlink debris", () => {
    const st = "\x1b]8;;http://localhost:5173/\x1b\\http://localhost:5173/\x1b]8;;\x1b\\";
    const links = split(st).filter((segment) => segment.href);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.text).toBe("http://localhost:5173/");
      expect(link.href).not.toContain("\x1b");
    }
    expect(hrefs("\x1b]8;;https://x.test/\x07label\x1b]8;;\x07")).toEqual(["https://x.test/"]);
  });
});
