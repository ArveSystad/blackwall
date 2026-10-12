import { DEFAULT_TAGS, type Agent, type Task } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { LEGACY_SEED_PROMPTS, SEED_AGENTS } from "./seeds.js";
import {
  AGENTS_SEEDED_KEY,
  AgentNotFoundError,
  CLI_TWINS_MERGED_KEY,
  InvalidAgentError,
  ROLE_DEFAULTS_KEY,
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
    tasks: r.tasks,
    backlogItems: r.backlogItems,
    transaction: r.transaction,
  });
});

afterEach(() => opened.close());

function byName(name: string): Agent {
  const agent = service.list().find((a) => a.name === name);
  if (!agent) throw new Error(`${name} not seeded`);
  return agent;
}

describe("seeding", () => {
  it("adds the built-in agents, the role defaults and tags, without CLI twins", () => {
    service.seed();
    expect(service.list().map((a) => a.name)).toEqual(SEED_AGENTS.map((a) => a.name).sort());
    expect(service.list().every((a) => Object.keys(a.models).length === 0)).toBe(true);
    expect(r.tags.names()).toEqual([...DEFAULT_TAGS]);
    expect(service.roleDefaults()).toEqual({
      planner: byName("Planner").id,
      planReviewers: [byName("Plan reviewer").id],
      implementer: byName("Implementer").id,
      codeReviewers: [byName("Code-quality reviewer").id, byName("Security reviewer").id],
      summarizer: byName("Summarizer").id,
    });
    expect(r.settings.get(CLI_TWINS_MERGED_KEY)).toBe(true);
  });

  it("seeds once, so deleted agents and tags stay deleted", () => {
    service.seed();
    service.delete(byName("Performance reviewer").id);
    r.tags.replace([]);
    service.seed();
    const names = service.list().map((a) => a.name);
    expect(names).not.toContain("Performance reviewer");
    expect(names).toHaveLength(SEED_AGENTS.length - 1);
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
    const own = service.create({ name: "Planner", eligibleStages: ["inform"] });
    service.seed();
    expect(byName("Planner")).toEqual(own);
    expect(service.roleDefaults().planner).toBe(own.id);
  });
});

describe("merging the CLI twins of an earlier install", () => {
  let repoId: string;

  /** An install that was already seeded, with per-CLI twins in its library. */
  beforeEach(() => {
    r.settings.set(AGENTS_SEEDED_KEY, true);
    r.settings.set("seeded.cliTwins", true);
    r.settings.set("roleDefaults.copilot", {});
    repoId = r.repos.create({ path: "/code/app", name: "app" }).id;
  });

  const agent = (input: Parameters<Repositories["agents"]["create"]>[0]): Agent =>
    r.agents.create({ eligibleStages: ["code-review"], ...input });

  function task(values: Partial<Parameters<Repositories["tasks"]["create"]>[0]>): Task {
    return r.tasks.create({
      title: "Fix login",
      origin: { kind: "free-text" },
      repoId,
      freeText: "Fix it",
      ...values,
    });
  }

  /** A step of `agentId` on `cli`, with a finding and a grill question it raised. */
  function history(taskId: string, agentId: string, cli: "claude" | "copilot") {
    const run = r.runs.listByTask(taskId).at(0) ?? r.runs.create(taskId);
    const step = r.steps.create({ runId: run.id, stage: "code-review", agentId, cli });
    const [finding] = r.findings.createMany([
      {
        taskId,
        stepId: step.id,
        reviewerAgentId: agentId,
        severity: "low",
        title: "Typo",
        explanation: "A typo.",
      },
    ]);
    const question = r.grillQuestions.create({ taskId, askedByAgentId: agentId, question: "?" });
    return { step, finding: finding!, question };
  }

  it("folds a Copilot twin into its base, keeping the base's prompt and stages", () => {
    const base = agent({
      name: "Docs reviewer",
      prompt: "Claude docs.",
      models: { claude: "opus" },
      permissionOverrides: { claude: { allow: ["Read"] } },
    });
    const twin = agent({
      name: "Docs reviewer (Copilot)",
      prompt: "Copilot docs.",
      eligibleStages: ["code-review", "plan-review"],
      models: { claude: "sonnet", copilot: "gpt-5" },
      permissionOverrides: { copilot: { allow: ["shell(npm test)"] } },
    });
    const t = task({ cli: "claude", agents: { codeReviewers: [twin.id] } });
    r.tasks.update(t.id, { agentClis: { [twin.id]: "copilot" } });
    const { step, finding, question } = history(t.id, twin.id, "copilot");
    r.settings.set(ROLE_DEFAULTS_KEY, { codeReviewers: [twin.id] });
    service.seed();

    expect(service.list()).toEqual([
      expect.objectContaining({
        id: base.id,
        name: "Docs reviewer",
        prompt: "Claude docs.",
        eligibleStages: ["code-review"],
        models: { claude: "opus", copilot: "gpt-5" },
        permissionOverrides: {
          claude: { allow: ["Read"] },
          copilot: { allow: ["shell(npm test)"] },
        },
      }),
    ]);
    expect(r.tasks.get(t.id)).toMatchObject({
      agents: { codeReviewers: [base.id] },
      agentClis: { [base.id]: "copilot" },
    });
    expect(r.steps.get(step.id)).toMatchObject({ agentId: base.id, cli: "copilot" });
    expect(r.findings.get(finding.id)?.reviewerAgentId).toBe(base.id);
    expect(r.grillQuestions.get(question.id)?.askedByAgentId).toBe(base.id);
    expect(service.roleDefaults()).toEqual({ codeReviewers: [base.id] });
    expect(r.settings.get("roleDefaults.copilot")).toBeUndefined();
    expect(r.settings.get("seeded.cliTwins")).toBeUndefined();
  });

  it("folds a Claude twin into its base, taking the twin's prompt, stages and entries", () => {
    const base = agent({
      name: "Y",
      prompt: "Copilot Y.",
      eligibleStages: ["code-review", "plan-review"],
      models: { copilot: "gpt-5", claude: "haiku" },
      permissionOverrides: { claude: { allow: ["Read"] } },
    });
    agent({
      name: "Y (Claude)",
      prompt: "Claude Y.",
      models: { claude: "opus" },
      permissionOverrides: { claude: { deny: ["Bash"] } },
    });
    service.seed();

    expect(service.list()).toEqual([
      expect.objectContaining({
        id: base.id,
        name: "Y",
        prompt: "Claude Y.",
        eligibleStages: ["code-review"],
        models: { claude: "opus", copilot: "gpt-5" },
        permissionOverrides: { claude: { deny: ["Bash"] } },
      }),
    ]);
  });

  it("folds numbered twins into one base", () => {
    const base = agent({ name: "Z", models: { claude: "opus" } });
    const first = agent({ name: "Z (Copilot)", models: { copilot: "gpt-5", claude: "sonnet" } });
    const second = agent({ name: "Z (Copilot 2)", models: { copilot: "gpt-4" } });
    const t = task({ cli: "claude", agents: { codeReviewers: [first.id, second.id] } });
    const steps = [history(t.id, first.id, "copilot"), history(t.id, second.id, "copilot")];
    service.seed();

    expect(service.list().map((a) => a.name)).toEqual(["Z"]);
    expect(byName("Z").models).toEqual({ claude: "opus", copilot: "gpt-5" });
    expect(steps.map(({ step }) => r.steps.get(step.id)?.agentId)).toEqual([base.id, base.id]);
    expect(r.tasks.get(t.id)?.agents).toEqual({ codeReviewers: [base.id] });
  });

  it("folds a pair listed together, in a finished task and a backlog item", () => {
    const base = agent({ name: "P" });
    const twin = agent({ name: "P (Copilot)" });
    const t = task({
      cli: "claude",
      status: "done",
      archivedAt: new Date(),
      agents: { codeReviewers: [base.id, twin.id] },
    });
    r.tasks.update(t.id, { agentClis: { [twin.id]: "copilot" } });
    const own = history(t.id, base.id, "claude");
    const twins = history(t.id, twin.id, "copilot");
    const item = r.backlogItems.insert({
      repoId,
      title: "Later",
      origin: { kind: "free-text" },
      freeText: "Later",
      agents: { codeReviewers: [twin.id, base.id] },
      agentClis: { [twin.id]: "copilot" },
    });
    service.seed();

    expect(service.list().map((a) => a.id)).toEqual([base.id]);
    // The base comes first in precedence, so its CLI (the task's) wins.
    expect(r.tasks.get(t.id)).toMatchObject({
      agents: { codeReviewers: [base.id] },
      agentClis: {},
      status: "done",
    });
    expect(r.steps.get(own.step.id)).toMatchObject({ agentId: base.id, cli: "claude" });
    expect(r.steps.get(twins.step.id)).toMatchObject({ agentId: base.id, cli: "copilot" });
    expect(r.findings.listByTask(t.id).map((f) => f.reviewerAgentId)).toEqual([base.id, base.id]);
    expect(r.backlogItems.get(item.id)).toMatchObject({
      agents: { codeReviewers: [base.id] },
      agentClis: {},
    });
  });

  it("gives the base a Claude twin's CLI choice, whatever the role order", () => {
    const base = agent({ name: "Q" });
    const twin = agent({ name: "Q (Claude)" });
    const roles = { codeReviewers: [base.id, twin.id] };
    const onClaude = task({ cli: "copilot", agents: roles });
    r.tasks.update(onClaude.id, { agentClis: { [twin.id]: "claude" } });
    const onCopilot = task({ cli: "copilot", agents: roles });
    service.seed();

    expect(r.tasks.get(onClaude.id)?.agentClis).toEqual({ [base.id]: "claude" });
    expect(r.tasks.get(onCopilot.id)?.agentClis).toEqual({});
  });

  it("drops the base from defaults and backlog roles its merged stages lost, not from tasks", () => {
    const base = agent({ name: "R", eligibleStages: ["code-review", "plan-review"] });
    const twin = agent({ name: "R (Claude)" });
    r.settings.set(ROLE_DEFAULTS_KEY, { planReviewers: [base.id], codeReviewers: [twin.id] });
    const item = r.backlogItems.insert({
      repoId,
      title: "Later",
      origin: { kind: "free-text" },
      freeText: "Later",
      agents: { planReviewers: [base.id], codeReviewers: [base.id] },
    });
    const t = task({ cli: "claude", agents: { planReviewers: [base.id] } });
    service.seed();

    expect(byName("R").eligibleStages).toEqual(["code-review"]);
    expect(service.roleDefaults()).toEqual({ planReviewers: [], codeReviewers: [base.id] });
    expect(r.backlogItems.get(item.id)?.agents).toEqual({
      planReviewers: [],
      codeReviewers: [base.id],
    });
    expect(r.tasks.get(t.id)?.agents).toEqual({ planReviewers: [base.id] });
  });

  it("leaves a twin whose base no longer exists alone", () => {
    const orphan = agent({ name: "Ghost (Copilot)", prompt: "Boo." });
    service.seed();
    expect(service.list()).toEqual([orphan]);
  });

  it("leaves an agent named after OpenCode alone: twins only existed for Claude and Copilot", () => {
    agent({ name: "S" });
    agent({ name: "S (OpenCode)", prompt: "Mine." });
    service.seed();
    expect(service.list().map((a) => [a.name, a.prompt])).toEqual([
      ["S", ""],
      ["S (OpenCode)", "Mine."],
    ]);
  });

  it("merges only once", () => {
    service.seed();
    agent({ name: "S" });
    agent({ name: "S (Copilot)" });
    service.seed();
    expect(service.list().map((a) => a.name)).toEqual(["S", "S (Copilot)"]);
  });
});

describe("agent CRUD", () => {
  it("creates, updates and deletes an agent", () => {
    const agent = service.create({ name: "Docs reviewer" });
    expect(agent).toMatchObject({
      models: {},
      prompt: "",
      eligibleStages: [],
      permissionOverrides: {},
    });

    const updated = service.update(agent.id, {
      models: { copilot: "gpt-5" },
      eligibleStages: ["code-review"],
      permissionOverrides: { claude: { allow: ["Bash(npm test:*)"] } },
    });
    expect(updated).toMatchObject({ name: "Docs reviewer", models: { copilot: "gpt-5" } });
    expect(updated.permissionOverrides.claude?.allow).toEqual(["Bash(npm test:*)"]);

    service.delete(agent.id);
    expect(() => service.get(agent.id)).toThrow(AgentNotFoundError);
  });

  it("rejects duplicate names and invalid input", () => {
    const agent = service.create({ name: "A" });
    service.create({ name: "B" });
    expect(() => service.create({ name: "A" })).toThrow(InvalidAgentError);
    expect(() => service.update(agent.id, { name: "B" })).toThrow(InvalidAgentError);
    expect(() => service.create({ name: " " })).toThrow(InvalidAgentError);
    expect(() => service.update("missing", { name: "C" })).toThrow(AgentNotFoundError);
  });

  it("rejects OpenCode rules outside OpenCode's grammar, saying what it expects", () => {
    const agent = service.create({ name: "A" });
    const save = (rule: string) =>
      service.update(agent.id, { permissionOverrides: { opencode: { allow: [rule] } } });
    expect(() => save("Bash(npm test:*)")).toThrow(InvalidAgentError);
    expect(() => save("Bash(npm test:*)")).toThrow(/bash\(npm test\*\)/);
    expect(save("bash(npm test*)").permissionOverrides.opencode?.allow).toEqual([
      "bash(npm test*)",
    ]);
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
    service.delete(byName("Security reviewer").id);
    service.delete(byName("Implementer").id);
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

  it("keeps only CLI choices for the task's agents that differ from its CLI", () => {
    const roles = service.resolveRoles();
    const planner = roles.planner!;
    const ux = byName("UX/design reviewer").id;
    const summarizer = roles.summarizer!;
    expect(
      service.resolveClis(
        roles,
        { [planner]: "copilot", [ux]: "copilot", [summarizer]: "claude" },
        "claude",
      ),
    ).toEqual({ [planner]: "copilot" });
  });

  it("lists the CLIs a task's agents run on", () => {
    const roles = service.resolveRoles();
    expect(service.clisFor(roles, {}, "copilot")).toEqual(["copilot"]);
    expect(service.clisFor(roles, { [roles.planner!]: "claude" }, "copilot").sort()).toEqual([
      "claude",
      "copilot",
    ]);
    expect(service.clisFor({}, {}, "claude")).toEqual([]);
  });
});

describe("invocation", () => {
  beforeEach(() => service.seed());

  it("gives a code reviewer read-only permissions, the tags and the findings contract", () => {
    r.tags.replace(["security", "spelling"]);
    const { systemPrompt, permissions } = service.invocation(
      byName("Security reviewer").id,
      "code-review",
      "copilot",
    );
    expect(permissions).toMatchObject({ cli: "copilot", profile: "read-only" });
    expect(permissions.deny).toContain("write");
    expect(systemPrompt).toContain("You are the security reviewer.");
    expect(systemPrompt).toContain("`security`, `spelling`");
    expect(systemPrompt).toContain("Findings output contract");
  });

  it("gives the implementer edit permissions without push", () => {
    const { permissions } = service.invocation(byName("Implementer").id, "implement", "claude");
    expect(permissions).toMatchObject({ cli: "claude", profile: "implement" });
    expect(permissions.allow).toContain("Edit");
    expect(permissions.deny).toContain("Bash(git push:*)");
  });

  it("tells implementers on Claude Code only about the sub-agent", () => {
    const implementer = byName("Implementer").id;
    expect(service.invocation(implementer, "implement", "claude").systemPrompt).toContain(
      "## Sub-agents",
    );
    expect(service.invocation(implementer, "implement", "copilot").systemPrompt).not.toContain(
      "## Sub-agents",
    );
  });

  it("uses the agent's model and permission overrides for the CLI it runs on", () => {
    const reviewer = byName("Code-quality reviewer");
    service.update(reviewer.id, {
      models: { claude: "opus" },
      permissionOverrides: {
        claude: { allow: ["Bash(npm test:*)"] },
        copilot: { allow: ["shell(npm test)"] },
      },
    });
    const onCopilot = service.invocation(reviewer.id, "code-review", "copilot");
    expect(onCopilot).toMatchObject({ cli: "copilot", model: null });
    expect(onCopilot.permissions.allow).toContain("shell(npm test)");
    expect(onCopilot.permissions.allow).not.toContain("Bash(npm test:*)");
    expect(onCopilot.permissions.deny).toContain("write");

    const onClaude = service.invocation(reviewer.id, "code-review", "claude");
    expect(onClaude).toMatchObject({ cli: "claude", model: "opus" });
    expect(onClaude.permissions.allow).toContain("Bash(npm test:*)");
    expect(onClaude.permissions.allow).not.toContain("shell(npm test)");
  });

  it("refuses a stage the agent is not eligible for", () => {
    expect(() => service.invocation(byName("Security reviewer").id, "implement", "claude")).toThrow(
      InvalidAgentError,
    );
  });
});
