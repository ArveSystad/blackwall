import {
  AGENT_ROLES,
  DEFAULT_TAGS,
  type Agent,
  type AgentCli,
  type RoleAgents,
} from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { LEGACY_SEED_PROMPTS, SEED_AGENTS } from "./seeds.js";
import {
  AGENTS_SEEDED_KEY,
  AgentNotFoundError,
  InvalidAgentError,
  ROLE_DEFAULTS_KEYS,
  createAgentService,
  type AgentService,
} from "./service.js";

let opened: OpenedDatabase;
let r: Repositories;
let service: AgentService;

beforeEach(() => {
  opened = openDatabase(":memory:");
  r = createRepositories(opened.db);
  service = createAgentService({
    agents: r.agents,
    settings: r.settings,
    tags: r.tags,
    repos: r.repos,
    backlogItems: r.backlogItems,
  });
});

afterEach(() => opened.close());

function byName(name: string): Agent {
  const agent = service.list().find((a) => a.name === name);
  if (!agent) throw new Error(`${name} not seeded`);
  return agent;
}

/** The CLIs of every agent in a role set. */
function clisOf(roles: RoleAgents): Set<AgentCli> {
  const ids = AGENT_ROLES.flatMap((role) => {
    const value = roles[role];
    return value === undefined ? [] : typeof value === "string" ? [value] : value;
  });
  return new Set(ids.map((id) => service.get(id).cli));
}

describe("seeding", () => {
  it("adds the built-in agents on Claude Code, their Copilot twins, role defaults and tags", () => {
    service.seed();
    const names = SEED_AGENTS.map((a) => a.name);
    expect(service.list().map((a) => a.name)).toEqual(
      [...names, ...names.map((n) => `${n} (Copilot)`)].sort(),
    );
    for (const name of names) {
      expect(byName(name).cli).toBe("claude");
      expect(byName(`${name} (Copilot)`).cli).toBe("copilot");
    }
    expect(r.tags.names()).toEqual([...DEFAULT_TAGS]);

    const expected = (suffix: string) => ({
      planner: byName(`Planner${suffix}`).id,
      planReviewers: [byName(`Plan reviewer${suffix}`).id],
      implementer: byName(`Implementer${suffix}`).id,
      codeReviewers: [
        byName(`Code-quality reviewer${suffix}`).id,
        byName(`Security reviewer${suffix}`).id,
      ],
      summarizer: byName(`Summarizer${suffix}`).id,
    });
    expect(service.roleDefaults()).toEqual(expected(""));
    expect(service.roleDefaults("copilot")).toEqual(expected(" (Copilot)"));
    expect(service.allRoleDefaults()).toEqual({
      claude: expected(""),
      copilot: expected(" (Copilot)"),
    });
  });

  it("gives a twin the prompt and stages but no model or overrides", () => {
    const own = service.create({
      name: "Docs reviewer",
      cli: "claude",
      model: "sonnet",
      prompt: "Review the docs.",
      eligibleStages: ["code-review"],
      permissionOverrides: { allow: ["Read"] },
    });
    service.seed();
    expect(byName("Docs reviewer (Copilot)")).toMatchObject({
      cli: "copilot",
      model: null,
      prompt: own.prompt,
      eligibleStages: own.eligibleStages,
      permissionOverrides: {},
    });
  });

  it("seeds once, so deleted agents, twins and tags stay deleted", () => {
    service.seed();
    service.delete(byName("Performance reviewer").id);
    service.delete(byName("Planner (Copilot)").id);
    r.tags.replace([]);
    service.seed();
    const names = service.list().map((a) => a.name);
    expect(names).not.toContain("Performance reviewer");
    expect(names).not.toContain("Planner (Copilot)");
    expect(names).toHaveLength(14);
    expect(r.tags.names()).toEqual([]);
  });

  it("upgrades unedited earlier seed prompts and keeps edited ones", () => {
    service.seed();
    const planner = byName("Planner");
    const security = byName("Security reviewer");
    service.update(planner.id, { prompt: LEGACY_SEED_PROMPTS.Planner![0] });
    service.update(security.id, { prompt: "My own security persona." });
    service.seed();
    expect(byName("Planner").prompt).toBe(SEED_AGENTS[0].prompt);
    expect(byName("Security reviewer").prompt).toBe("My own security persona.");
  });

  it("gives every seed a persona that names its output contract", () => {
    for (const seed of SEED_AGENTS) {
      if (seed.eligibleStages.some((s) => s === "code-review")) {
        expect(seed.prompt).toContain("findings output contract");
      }
    }
    const prompt = (name: string) => SEED_AGENTS.find((a) => a.name === name)!.prompt;
    expect(prompt("Planner")).toContain("plan output contract");
    expect(prompt("Plan reviewer")).toContain("questions output contract");
    expect(prompt("Plan reviewer")).toContain("needsHuman");
    expect(prompt("Implementer")).toMatch(/Do not commit and do not push/);
    expect(prompt("Summarizer")).toMatch(/commit message/i);
  });

  it("keeps an existing agent with a seed name", () => {
    const own = service.create({ name: "Planner", cli: "copilot", eligibleStages: ["inform"] });
    service.seed();
    expect(byName("Planner")).toEqual(own);
    expect(service.roleDefaults("copilot").planner).toBe(own.id);
    expect(service.roleDefaults().planner).toBe(byName("Planner (Claude)").id);
  });
});

describe("CLI twins on an existing install", () => {
  /** The library as seeded before twinning: authors on Claude Code, reviewers on Copilot. */
  function oldInstall(): Record<string, string> {
    const copilot = new Set<string>([
      "Summarizer",
      "Plan reviewer",
      "Code-quality reviewer",
      "Security reviewer",
    ]);
    const ids: Record<string, string> = {};
    for (const seed of SEED_AGENTS) {
      ids[seed.name] = r.agents.create({
        ...seed,
        cli: copilot.has(seed.name) ? "copilot" : "claude",
        eligibleStages: [...seed.eligibleStages],
      }).id;
    }
    r.settings.set(AGENTS_SEEDED_KEY, true);
    return ids;
  }

  it("twins agents both ways and maps the chosen defaults onto each CLI", () => {
    const id = oldInstall();
    const docs = r.agents.create({
      name: "Docs reviewer",
      cli: "copilot",
      eligibleStages: ["code-review"],
    }).id;
    r.settings.set(ROLE_DEFAULTS_KEYS.claude, {
      planner: id["Planner"],
      planReviewers: [id["Plan reviewer"]],
      implementer: id["Implementer"],
      codeReviewers: [id["Security reviewer"], docs, id["UX/design reviewer"]],
      summarizer: id["Summarizer"],
    });
    service.seed();

    expect(byName("Planner (Copilot)").cli).toBe("copilot");
    expect(byName("Plan reviewer (Claude)").cli).toBe("claude");
    expect(byName("Docs reviewer (Claude)").cli).toBe("claude");
    expect(service.list()).toHaveLength(18);

    expect(service.roleDefaults()).toEqual({
      planner: id["Planner"],
      planReviewers: [byName("Plan reviewer (Claude)").id],
      implementer: id["Implementer"],
      codeReviewers: [
        byName("Security reviewer (Claude)").id,
        byName("Docs reviewer (Claude)").id,
        id["UX/design reviewer"],
      ],
      summarizer: byName("Summarizer (Claude)").id,
    });
    expect(service.roleDefaults("copilot")).toEqual({
      planner: byName("Planner (Copilot)").id,
      planReviewers: [id["Plan reviewer"]],
      implementer: byName("Implementer (Copilot)").id,
      codeReviewers: [id["Security reviewer"], docs, byName("UX/design reviewer (Copilot)").id],
      summarizer: id["Summarizer"],
    });
    expect(clisOf(service.roleDefaults())).toEqual(new Set(["claude"]));
    expect(clisOf(service.roleDefaults("copilot"))).toEqual(new Set(["copilot"]));
  });

  it("adopts an existing twin on the other CLI", () => {
    const id = oldInstall();
    r.settings.set(ROLE_DEFAULTS_KEYS.claude, { planner: id["Planner"] });
    const own = r.agents.create({
      name: "Planner (Copilot)",
      cli: "copilot",
      eligibleStages: ["inform", "plan-review"],
    });
    service.seed();
    expect(service.list().filter((a) => a.name.startsWith("Planner"))).toHaveLength(2);
    expect(service.roleDefaults("copilot").planner).toBe(own.id);
  });

  it("numbers a twin whose name is taken on the wrong CLI", () => {
    oldInstall();
    r.agents.create({ name: "Y", cli: "claude", prompt: "Y", eligibleStages: ["code-review"] });
    r.agents.create({ name: "Y (Copilot)", cli: "claude", eligibleStages: ["code-review"] });
    expect(() => service.seed()).not.toThrow();
    expect(byName("Y (Copilot 2)")).toMatchObject({ cli: "copilot", prompt: "Y" });
    expect(byName("Y (Copilot) (Copilot)").cli).toBe("copilot");
  });

  it("numbers a twin whose name belongs to an agent already paired", () => {
    oldInstall();
    r.agents.create({ name: "Z", cli: "copilot", eligibleStages: ["code-review"] });
    r.agents.create({ name: "Z (Claude)", cli: "claude", eligibleStages: ["code-review"] });
    service.seed();
    // `Z (Claude)` is paired with its own Copilot twin first, so `Z` gets the next free name.
    expect(byName("Z (Claude) (Copilot)").cli).toBe("copilot");
    expect(byName("Z (Claude 2)").cli).toBe("claude");
  });

  it("moves unpromoted backlog items onto their repo's CLI once", () => {
    const id = oldInstall();
    const jbf = r.repos.create({ path: "/code/jbf", name: "jbf", defaultCli: "copilot" });
    const app = r.repos.create({ path: "/code/app", name: "app" });
    const mixed: RoleAgents = {
      planner: id["Planner"],
      codeReviewers: [id["Security reviewer"]!, id["UX/design reviewer"]!],
    };
    const item = (repoId: string, title: string, status: "waiting" | "paused" | "promoted") =>
      r.backlogItems.insert({
        repoId,
        title,
        origin: { kind: "free-text" },
        agents: mixed,
        status,
      }).id;
    const jbfWaiting = item(jbf.id, "a", "waiting");
    const jbfPaused = item(jbf.id, "b", "paused");
    const jbfPromoted = item(jbf.id, "c", "promoted");
    const appWaiting = item(app.id, "d", "waiting");
    service.seed();

    const agentsOf = (itemId: string) => r.backlogItems.get(itemId)!.agents;
    expect(agentsOf(jbfWaiting)).toEqual({
      planner: byName("Planner (Copilot)").id,
      codeReviewers: [id["Security reviewer"], byName("UX/design reviewer (Copilot)").id],
    });
    expect(clisOf(agentsOf(jbfPaused))).toEqual(new Set(["copilot"]));
    expect(clisOf(agentsOf(appWaiting))).toEqual(new Set(["claude"]));
    expect(agentsOf(jbfPromoted)).toEqual(mixed);

    r.backlogItems.update(appWaiting, { agents: mixed });
    service.seed();
    expect(agentsOf(appWaiting)).toEqual(mixed);
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

  it("drops a deleted agent from the defaults of every CLI", () => {
    const security = byName("Security reviewer").id;
    const implementer = byName("Implementer").id;
    service.setRoleDefaults({ ...service.roleDefaults("copilot"), implementer }, "copilot");
    service.delete(security);
    service.delete(implementer);
    service.delete(byName("Security reviewer (Copilot)").id);
    const defaults = service.roleDefaults();
    expect(defaults.codeReviewers).toEqual([byName("Code-quality reviewer").id]);
    expect(defaults.implementer).toBeUndefined();
    const copilot = service.roleDefaults("copilot");
    expect(copilot.codeReviewers).toEqual([byName("Code-quality reviewer (Copilot)").id]);
    expect(copilot.implementer).toBeUndefined();
  });

  it("keeps each CLI's defaults apart", () => {
    const ux = byName("UX/design reviewer (Copilot)").id;
    service.setRoleDefaults({ codeReviewers: [ux] }, "copilot");
    expect(service.roleDefaults("copilot")).toEqual({ codeReviewers: [ux] });
    expect(service.roleDefaults().codeReviewers).toHaveLength(2);
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

  it("resolves a task's agents and CLIs from the chosen CLI's defaults", () => {
    const roles = service.resolveRoles({}, "copilot");
    expect(roles.planner).toBe(byName("Planner (Copilot)").id);
    expect(clisOf(roles)).toEqual(new Set(["copilot"]));
    expect(service.clisFor({}, "copilot")).toEqual(["copilot"]);
    expect(service.clisFor()).toEqual(["claude"]);
    const planner = byName("Planner").id;
    expect(service.clisFor({ planner }, "copilot").sort()).toEqual(["claude", "copilot"]);
  });
});

describe("invocation", () => {
  beforeEach(() => service.seed());

  it("gives a code reviewer read-only permissions, the tags and the findings contract", () => {
    r.tags.replace(["security", "spelling"]);
    const { systemPrompt, permissions } = service.invocation(
      byName("Security reviewer (Copilot)").id,
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
    const reviewer = byName("Code-quality reviewer (Copilot)");
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
