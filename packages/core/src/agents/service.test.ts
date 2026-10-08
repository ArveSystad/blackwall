import { DEFAULT_TAGS, type Agent } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { SEED_AGENTS } from "./seeds.js";
import {
  AgentNotFoundError,
  InvalidAgentError,
  createAgentService,
  type AgentService,
} from "./service.js";

let opened: OpenedDatabase;
let r: Repositories;
let service: AgentService;

beforeEach(() => {
  opened = openDatabase(":memory:");
  r = createRepositories(opened.db);
  service = createAgentService({ agents: r.agents, settings: r.settings, tags: r.tags });
});

afterEach(() => opened.close());

function byName(name: string): Agent {
  const agent = service.list().find((a) => a.name === name);
  if (!agent) throw new Error(`${name} not seeded`);
  return agent;
}

describe("seeding", () => {
  it("adds the built-in agents, role defaults and tags", () => {
    service.seed();
    expect(service.list().map((a) => a.name)).toEqual(SEED_AGENTS.map((a) => a.name).sort());
    expect(r.tags.names()).toEqual([...DEFAULT_TAGS]);

    const defaults = service.roleDefaults();
    expect(defaults).toEqual({
      planner: byName("Planner").id,
      planReviewers: [byName("Plan reviewer").id],
      implementer: byName("Implementer").id,
      codeReviewers: [byName("Code-quality reviewer").id, byName("Security reviewer").id],
      summarizer: byName("Summarizer").id,
    });
  });

  it("defaults reviewers to a different CLI than the authors", () => {
    service.seed();
    const defaults = service.roleDefaults();
    const cli = (id: string | undefined) => service.get(id ?? "").cli;
    const authors = new Set([cli(defaults.planner), cli(defaults.implementer)]);
    const reviewers = [...(defaults.planReviewers ?? []), ...(defaults.codeReviewers ?? [])];
    expect(reviewers.length).toBeGreaterThan(0);
    for (const id of reviewers) expect(authors.has(cli(id))).toBe(false);
  });

  it("seeds once, so deleted agents and tags stay deleted", () => {
    service.seed();
    service.delete(byName("Performance reviewer").id);
    r.tags.replace([]);
    service.seed();
    expect(service.list().some((a) => a.name === "Performance reviewer")).toBe(false);
    expect(r.tags.names()).toEqual([]);
  });

  it("keeps an existing agent with a seed name", () => {
    const own = service.create({ name: "Planner", cli: "copilot", eligibleStages: ["inform"] });
    service.seed();
    expect(byName("Planner")).toEqual(own);
    expect(service.roleDefaults().planner).toBe(own.id);
  });
});

describe("agent CRUD", () => {
  it("creates, updates and deletes an agent", () => {
    const agent = service.create({ name: "Docs reviewer", cli: "claude" });
    expect(agent).toMatchObject({ model: null, prompt: "", eligibleStages: [] });

    const updated = service.update(agent.id, {
      model: "sonnet",
      eligibleStages: ["code-review"],
      permissionOverrides: { allow: ["Bash(npm test:*)"] },
    });
    expect(updated).toMatchObject({ name: "Docs reviewer", model: "sonnet" });
    expect(updated.permissionOverrides.allow).toEqual(["Bash(npm test:*)"]);

    service.delete(agent.id);
    expect(() => service.get(agent.id)).toThrow(AgentNotFoundError);
  });

  it("rejects duplicate names and invalid input", () => {
    const agent = service.create({ name: "A", cli: "claude" });
    service.create({ name: "B", cli: "claude" });
    expect(() => service.create({ name: "A", cli: "copilot" })).toThrow(InvalidAgentError);
    expect(() => service.update(agent.id, { name: "B" })).toThrow(InvalidAgentError);
    expect(() => service.create({ name: " ", cli: "claude" })).toThrow(InvalidAgentError);
    expect(() => service.update("missing", { name: "C" })).toThrow(AgentNotFoundError);
  });
});

describe("role defaults", () => {
  beforeEach(() => service.seed());

  it("only accepts existing agents eligible for the role's stage", () => {
    const security = byName("Security reviewer").id;
    expect(service.setRoleDefaults({ codeReviewers: [security] })).toEqual({
      codeReviewers: [security],
    });
    expect(() => service.setRoleDefaults({ implementer: security })).toThrow(/not eligible/);
    expect(() => service.setRoleDefaults({ planner: "missing" })).toThrow(/does not exist/);
    expect(() => service.setRoleDefaults({ codeReviewers: [security, security] })).toThrow(/twice/);
  });

  it("drops a deleted agent from the defaults", () => {
    const security = byName("Security reviewer").id;
    const implementer = byName("Implementer").id;
    service.delete(security);
    service.delete(implementer);
    const defaults = service.roleDefaults();
    expect(defaults.codeReviewers).toEqual([byName("Code-quality reviewer").id]);
    expect(defaults.implementer).toBeUndefined();
  });

  it("drops an agent from roles it is no longer eligible for", () => {
    const planner = byName("Planner").id;
    service.update(planner, { eligibleStages: ["plan-review"] });
    expect(service.roleDefaults().planner).toBeUndefined();
  });

  it("resolves a new task's agents from the defaults and the form's choices", () => {
    const ux = byName("UX/design reviewer").id;
    const roles = service.resolveRoles({ codeReviewers: [ux] });
    expect(roles.codeReviewers).toEqual([ux]);
    expect(roles.planner).toBe(byName("Planner").id);
    expect(() => service.resolveRoles({ summarizer: ux })).toThrow(InvalidAgentError);
  });
});

describe("invocation", () => {
  beforeEach(() => service.seed());

  it("gives a code reviewer read-only permissions, the tags and the findings contract", () => {
    r.tags.replace(["security", "spelling"]);
    const { systemPrompt, permissions } = service.invocation(
      byName("Security reviewer").id,
      "code-review",
    );
    expect(permissions).toMatchObject({ cli: "copilot", profile: "read-only" });
    expect(permissions.deny).toContain("write");
    expect(systemPrompt).toContain("You are the security reviewer.");
    expect(systemPrompt).toContain("`security`, `spelling`");
    expect(systemPrompt).toContain("Findings output contract");
  });

  it("gives the implementer edit permissions without push", () => {
    const { permissions } = service.invocation(byName("Implementer").id, "implement");
    expect(permissions).toMatchObject({ cli: "claude", profile: "implement" });
    expect(permissions.allow).toContain("Edit");
    expect(permissions.deny).toContain("Bash(git push:*)");
  });

  it("applies the agent's permission overrides", () => {
    const reviewer = byName("Code-quality reviewer");
    service.update(reviewer.id, { permissionOverrides: { allow: ["shell(npm test)"] } });
    const { permissions } = service.invocation(reviewer.id, "code-review");
    expect(permissions.allow).toContain("shell(npm test)");
    expect(permissions.deny).toContain("write");
  });

  it("refuses a stage the agent is not eligible for", () => {
    expect(() => service.invocation(byName("Security reviewer").id, "implement")).toThrow(
      InvalidAgentError,
    );
  });
});
