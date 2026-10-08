import { DEFAULT_TAGS } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentService } from "../agents/service.js";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { InvalidSettingsError, createSettingsService, type SettingsService } from "./service.js";

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
    const agents = createAgentService({ agents: r.agents, settings: r.settings, tags: r.tags });
    agents.seed();
    service.setTags({ tags: ["only-this-tag"] });
    const reviewer = agents.list().find((a) => a.name === "Security reviewer");
    if (!reviewer) throw new Error("not seeded");
    const { systemPrompt } = agents.invocation(reviewer.id, "code-review");
    expect(systemPrompt).toContain("only-this-tag");
    expect(systemPrompt).not.toContain("accessibility");
  });
});

describe("general settings", () => {
  it("defaults the concurrency cap to 3", () => {
    expect(service.general()).toEqual({ maxTasksPerRepo: 3 });
  });

  it("persists the concurrency cap", () => {
    expect(service.updateGeneral({ maxTasksPerRepo: 5 })).toEqual({ maxTasksPerRepo: 5 });
    const reopened = createSettingsService({ settings: r.settings, tags: r.tags });
    expect(reopened.maxTasksPerRepo()).toBe(5);
  });

  it("keeps the value when the patch omits it and rejects out-of-range caps", () => {
    service.updateGeneral({ maxTasksPerRepo: 2 });
    expect(service.updateGeneral({})).toEqual({ maxTasksPerRepo: 2 });
    expect(() => service.updateGeneral({ maxTasksPerRepo: 0 })).toThrow(InvalidSettingsError);
    expect(() => service.updateGeneral({ maxTasksPerRepo: 1.5 })).toThrow(InvalidSettingsError);
  });
});
