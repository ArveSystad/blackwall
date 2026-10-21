import { DEFAULT_TAGS } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentService } from "../agents/service.js";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import {
  InvalidSettingsError,
  createSettingsService,
  repoBacklogRunnerKey,
  type SettingsService,
} from "./service.js";

let opened: OpenedDatabase;
let r: Repositories;
let service: SettingsService;

beforeEach(() => {
  opened = openDatabase(":memory:");
  r = createRepositories(opened.db);
  service = createSettingsService({ settings: r.settings, tags: r.tags });
});

afterEach(() => opened.close());

describe("tags", () => {
  it("replaces the list in the given order", () => {
    r.tags.replace(DEFAULT_TAGS);
    expect(service.setTags({ tags: ["security", "ux", "flaky-tests"] })).toEqual([
      "security",
      "ux",
      "flaky-tests",
    ]);
    expect(service.tags()).toEqual(["security", "ux", "flaky-tests"]);
  });

  it("rejects duplicates and malformed names", () => {
    expect(() => service.setTags({ tags: ["ux", "ux"] })).toThrow(InvalidSettingsError);
    expect(() => service.setTags({ tags: ["Code Quality"] })).toThrow(InvalidSettingsError);
  });

  it("feeds the new list into code reviewer prompts", () => {
    const agents = createAgentService({
      agents: r.agents,
      settings: r.settings,
      tags: r.tags,
      repos: r.repos,
      tasks: r.tasks,
      backlogItems: r.backlogItems,
      transaction: r.transaction,
    });
    agents.seed();
    service.setTags({ tags: ["only-this-tag"] });
    const reviewer = agents.list().find((a) => a.name === "Security reviewer");
    if (!reviewer) throw new Error("not seeded");
    const { systemPrompt } = agents.invocation(reviewer.id, "code-review", "claude");
    expect(systemPrompt).toContain("only-this-tag");
    expect(systemPrompt).not.toContain("accessibility");
  });
});

const DEFAULTS = {
  maxTasksPerRepo: 3,
  backlogRunner: true,
  maxBacklogTasksPerRepo: 1,
  stopBacklogOnNeedsYou: true,
  githubIssuesRefreshSeconds: 60,
  voiceModel: "moonshine-tiny-en",
  voiceHotkey: null,
};

describe("general settings", () => {
  it("defaults the concurrency cap to 3 and the backlog runner to on, one task, stop on needs-you", () => {
    expect(service.general()).toEqual(DEFAULTS);
  });

  it("persists the concurrency cap and the backlog runner settings", () => {
    expect(service.updateGeneral({ maxTasksPerRepo: 5 })).toEqual({
      ...DEFAULTS,
      maxTasksPerRepo: 5,
    });
    service.updateGeneral({
      backlogRunner: false,
      maxBacklogTasksPerRepo: 2,
      stopBacklogOnNeedsYou: false,
      githubIssuesRefreshSeconds: 30,
      voiceModel: "whisper-small",
    });
    const reopened = createSettingsService({ settings: r.settings, tags: r.tags });
    expect(reopened.maxTasksPerRepo()).toBe(5);
    expect(reopened.general()).toEqual({
      maxTasksPerRepo: 5,
      backlogRunner: false,
      maxBacklogTasksPerRepo: 2,
      stopBacklogOnNeedsYou: false,
      githubIssuesRefreshSeconds: 30,
      voiceModel: "whisper-small",
      voiceHotkey: null,
    });
  });

  it("keeps the value when the patch omits it and rejects out-of-range caps", () => {
    service.updateGeneral({ maxTasksPerRepo: 2 });
    expect(service.updateGeneral({})).toEqual({ ...DEFAULTS, maxTasksPerRepo: 2 });
    expect(() => service.updateGeneral({ maxTasksPerRepo: 0 })).toThrow(InvalidSettingsError);
    expect(() => service.updateGeneral({ maxTasksPerRepo: 1.5 })).toThrow(InvalidSettingsError);
    expect(() => service.updateGeneral({ maxBacklogTasksPerRepo: 0 })).toThrow(
      InvalidSettingsError,
    );
    expect(() => service.updateGeneral({ githubIssuesRefreshSeconds: 5 })).toThrow(
      InvalidSettingsError,
    );
  });

  it("falls back per field when a stored value is invalid", () => {
    r.settings.set("maxBacklogTasksPerRepo", "lots");
    r.settings.set("maxTasksPerRepo", 4);
    expect(service.general()).toEqual({ ...DEFAULTS, maxTasksPerRepo: 4 });
  });

  it("falls back to the default refresh interval when the stored one is out of range", () => {
    r.settings.set("githubIssuesRefreshSeconds", 1);
    expect(service.general().githubIssuesRefreshSeconds).toBe(60);
  });

  it("falls back to the default voice model when the stored one is unknown", () => {
    r.settings.set("voiceModel", "whisper-huge");
    expect(service.general().voiceModel).toBe("moonshine-tiny-en");
    expect(() => service.updateGeneral({ voiceModel: "nope" as never })).toThrow(
      InvalidSettingsError,
    );
  });

  const F9 = { code: "F9", ctrl: false, alt: false, shift: false, meta: false };

  it("stores the hold-to-talk key and clears it with null", () => {
    expect(service.updateGeneral({ voiceHotkey: F9 }).voiceHotkey).toEqual(F9);
    const reopened = createSettingsService({ settings: r.settings, tags: r.tags });
    expect(reopened.general().voiceHotkey).toEqual(F9);
    expect(service.updateGeneral({ voiceModel: "whisper-small" }).voiceHotkey).toEqual(F9);
    expect(service.updateGeneral({ voiceHotkey: null }).voiceHotkey).toBeNull();
  });

  it("falls back to no hold-to-talk key when the stored one is invalid or reserved", () => {
    r.settings.set("voiceHotkey", { ...F9, code: "Escape" });
    expect(service.general().voiceHotkey).toBeNull();
    r.settings.set("voiceHotkey", { ...F9, code: "KeyW", ctrl: true });
    expect(service.general().voiceHotkey).toBeNull();
    expect(() => service.updateGeneral({ voiceHotkey: { ...F9, code: "KeyP" } })).toThrow(
      InvalidSettingsError,
    );
    expect(() => service.updateGeneral({ voiceHotkey: { ...F9, code: "F12" } })).toThrow(
      InvalidSettingsError,
    );
  });
});

describe("repo backlog runner", () => {
  it("is on and not halted by default, and keeps switch and halt per repo", () => {
    expect(service.repoBacklogRunner("r1")).toEqual({
      enabled: true,
      haltedTaskId: null,
      haltedAt: null,
      autonomous: false,
      includeRemoteIssues: false,
    });
    service.setRepoBacklogRunnerEnabled("r1", false);
    const at = new Date("2026-10-09T10:00:00Z");
    service.setRepoBacklogHalt("r1", "t1", at);
    expect(service.repoBacklogRunner("r1")).toEqual({
      enabled: false,
      haltedTaskId: "t1",
      haltedAt: at,
      autonomous: false,
      includeRemoteIssues: false,
    });
    expect(service.repoBacklogRunner("r2").enabled).toBe(true);
    expect(service.setRepoBacklogHalt("r1", null)).toEqual({
      enabled: false,
      haltedTaskId: null,
      haltedAt: null,
      autonomous: false,
      includeRemoteIssues: false,
    });
  });

  it("switches autonomous mode per repo, keeping the switch and halt", () => {
    const at = new Date("2026-10-09T10:00:00Z");
    service.setRepoBacklogRunnerEnabled("r1", false);
    service.setRepoBacklogHalt("r1", "t1", at);
    expect(service.setRepoBacklogAutonomous("r1", true)).toEqual({
      enabled: false,
      haltedTaskId: "t1",
      haltedAt: at,
      autonomous: true,
      includeRemoteIssues: false,
    });
    expect(service.repoBacklogRunner("r1").autonomous).toBe(true);
    expect(service.repoBacklogRunner("r2").autonomous).toBe(false);
    // Turning the runner on again keeps autonomy.
    expect(service.setRepoBacklogRunnerEnabled("r1", true).autonomous).toBe(true);
    expect(service.setRepoBacklogAutonomous("r1", false).autonomous).toBe(false);
  });

  it("switches remote issues per repo, kept by the other setters", () => {
    const at = new Date("2026-10-09T10:00:00Z");
    expect(service.setRepoBacklogIncludeRemoteIssues("r1", true).includeRemoteIssues).toBe(true);
    expect(service.repoBacklogRunner("r2").includeRemoteIssues).toBe(false);
    service.setRepoBacklogRunnerEnabled("r1", false);
    service.setRepoBacklogAutonomous("r1", true);
    service.setRepoBacklogHalt("r1", "t1", at);
    expect(service.repoBacklogRunner("r1")).toEqual({
      enabled: false,
      haltedTaskId: "t1",
      haltedAt: at,
      autonomous: true,
      includeRemoteIssues: true,
    });
    expect(service.setRepoBacklogIncludeRemoteIssues("r1", false)).toMatchObject({
      enabled: false,
      autonomous: true,
      haltedTaskId: "t1",
      includeRemoteIssues: false,
    });
  });

  it("reads a stored row from before autonomous mode as not autonomous", () => {
    r.settings.set(repoBacklogRunnerKey("r1"), {
      enabled: false,
      haltedTaskId: null,
      haltedAt: null,
    });
    expect(service.repoBacklogRunner("r1")).toMatchObject({ enabled: false, autonomous: false });
  });
});
