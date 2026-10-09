import {
  AGENT_CLIS,
  AGENT_ROLES,
  DEFAULT_TAGS,
  ROLE_STAGES,
  agentInputSchema,
  agentUpdateSchema,
  roleAgentsSchema,
  stagePermissionProfile,
  type Agent,
  type AgentCli,
  type AgentInput,
  type AgentRole,
  type AgentUpdate,
  type RoleAgents,
  type RoleDefaultsByCli,
  type Stage,
} from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";
import { permissionsFor, type AgentPermissions } from "./permissions.js";
import { buildSystemPrompt } from "./prompts.js";
import { CLI_TWIN_SUFFIX, LEGACY_SEED_PROMPTS, SEED_AGENTS, SEED_ROLE_DEFAULTS } from "./seeds.js";

/** Rejected agent or role-default input. Safe to show the user. */
export class InvalidAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentError";
  }
}

export class AgentNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Agent ${id} not found`);
    this.name = "AgentNotFoundError";
  }
}

/** Settings keys holding the default agent per role, one set per CLI. */
export const ROLE_DEFAULTS_KEYS: Record<AgentCli, string> = {
  claude: "roleDefaults",
  copilot: "roleDefaults.copilot",
};
/** Settings keys recording that the built-in agents and tags were seeded, so deleting them sticks. */
export const AGENTS_SEEDED_KEY = "seeded.agents";
export const TAGS_SEEDED_KEY = "seeded.tags";
/** Settings key recording that every agent got its twin on the other CLI. */
export const CLI_TWINS_SEEDED_KEY = "seeded.cliTwins";

/** Everything a step needs to invoke an agent: its persona, prompt and permissions. */
export interface AgentInvocation {
  agent: Agent;
  stage: Stage;
  systemPrompt: string;
  permissions: AgentPermissions;
}

export interface AgentServiceOptions {
  agents: Repositories["agents"];
  settings: Repositories["settings"];
  tags: Repositories["tags"];
  repos: Repositories["repos"];
  backlogItems: Repositories["backlogItems"];
}

export type AgentService = ReturnType<typeof createAgentService>;

function invalid(error: { issues: readonly { message: string }[] }): InvalidAgentError {
  return new InvalidAgentError(error.issues.map((issue) => issue.message).join("; "));
}

function roleIds(roles: RoleAgents, role: AgentRole): string[] {
  const value = roles[role];
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value;
}

const otherCli = (cli: AgentCli): AgentCli => (cli === "claude" ? "copilot" : "claude");

/** First name among `X (Copilot)`, `X (Copilot 2)`, … not in `taken`. */
function freeTwinName(base: string, cli: AgentCli, taken: ReadonlySet<string>): string {
  const suffix = CLI_TWIN_SUFFIX[cli];
  let name = `${base} (${suffix})`;
  for (let n = 2; taken.has(name); n++) name = `${base} (${suffix} ${n})`;
  return name;
}

function sameRoles(a: RoleAgents, b: RoleAgents): boolean {
  return AGENT_ROLES.every((role) => JSON.stringify(a[role]) === JSON.stringify(b[role]));
}

/**
 * The agent library: user-managed agents (CLI, model, persona, eligible stages,
 * permission overrides), the default agent per pipeline role, and the prompt and
 * permissions an agent gets for a stage.
 */
export function createAgentService({
  agents,
  settings,
  tags,
  repos,
  backlogItems,
}: AgentServiceOptions) {
  function existing(id: string): Agent {
    const agent = agents.get(id);
    if (!agent) throw new AgentNotFoundError(id);
    return agent;
  }

  /** Built-in agents still on an earlier seed prompt the user never edited get the current one. */
  function upgradeSeedPrompts(): void {
    const legacy: Partial<Record<string, readonly string[]>> = LEGACY_SEED_PROMPTS;
    for (const seed of SEED_AGENTS) {
      const agent = agents.list().find((a) => a.name === seed.name);
      if (agent && legacy[seed.name]?.includes(agent.prompt)) {
        agents.update(agent.id, { prompt: seed.prompt });
      }
    }
  }

  function assertUniqueName(name: string, id?: string): void {
    if (agents.list().some((a) => a.id !== id && a.name === name)) {
      throw new InvalidAgentError(`An agent named ${name} already exists`);
    }
  }

  function assertEligible(agent: Agent, stage: Stage): void {
    if (!agent.eligibleStages.includes(stage)) {
      throw new InvalidAgentError(`${agent.name} is not eligible for the ${stage} stage`);
    }
  }

  /** Validates role assignments: known agents, eligible for the role's stage, no repeats in a panel. */
  function checkRoles(input: unknown): RoleAgents {
    const parsed = roleAgentsSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error);
    for (const role of AGENT_ROLES) {
      const ids = roleIds(parsed.data, role);
      if (new Set(ids).size !== ids.length) {
        throw new InvalidAgentError(`An agent is listed twice for ${role}`);
      }
      for (const id of ids) {
        const agent = agents.get(id);
        if (!agent) throw new InvalidAgentError(`Agent ${id} does not exist`);
        assertEligible(agent, ROLE_STAGES[role]);
      }
    }
    return parsed.data;
  }

  /** The role defaults of one CLI's set. */
  function roleDefaults(cli: AgentCli = "claude"): RoleAgents {
    const parsed = roleAgentsSchema.safeParse(settings.get(ROLE_DEFAULTS_KEYS[cli]) ?? {});
    return parsed.success ? parsed.data : {};
  }

  /** Maps each role's agents through `map`, dropping unmapped ones and repeats; single roles stay single. */
  function mapRoleIds(
    roles: RoleAgents,
    map: (role: AgentRole, id: string) => string | undefined,
  ): RoleAgents {
    const next: RoleAgents = {};
    for (const role of AGENT_ROLES) {
      const value = roles[role];
      if (value === undefined) continue;
      const ids = [...new Set(roleIds(roles, role).flatMap((id) => map(role, id) ?? []))];
      if (typeof value !== "string") Object.assign(next, { [role]: ids });
      else if (ids[0] !== undefined) Object.assign(next, { [role]: ids[0] });
    }
    return next;
  }

  /** Drops an agent from the role defaults (after it is deleted or no longer eligible). */
  function pruneRoleDefaults(keep: (role: AgentRole, id: string) => boolean): void {
    for (const cli of AGENT_CLIS) {
      // An unset set is left unset, so seeding can still derive it.
      if (settings.get(ROLE_DEFAULTS_KEYS[cli]) === undefined) continue;
      settings.set(
        ROLE_DEFAULTS_KEYS[cli],
        mapRoleIds(roleDefaults(cli), (role, id) => (keep(role, id) ? id : undefined)),
      );
    }
  }

  /**
   * The agents for a new task: the role defaults of `cli` with the new-task
   * form's choices on top. Validated like the defaults.
   */
  function resolveRoles(overrides: RoleAgents = {}, cli: AgentCli = "claude"): RoleAgents {
    const chosen = Object.fromEntries(
      Object.entries(checkRoles(overrides)).filter(([, value]) => value !== undefined),
    );
    return { ...roleDefaults(cli), ...chosen };
  }

  /**
   * Gives every agent a twin on the other CLI, derives each CLI's role
   * defaults from the current ones, and moves unpromoted backlog items onto
   * their repo's default CLI. Runs once, so twins the user deletes stay
   * deleted. An existing agent named exactly like the twin and already on the
   * twin's CLI is adopted as the twin instead of creating another.
   */
  function seedCliTwins(): void {
    if (settings.get(CLI_TWINS_SEEDED_KEY) === true) return;
    const library = agents.list();
    const byName = new Map(library.map((a) => [a.name, a]));
    const taken = new Set(byName.keys());
    const counterpart = new Map<string, Record<AgentCli, string>>();
    const pair = (a: Agent, b: Agent) => {
      const ids = { [a.cli]: a.id, [b.cli]: b.id } as Record<AgentCli, string>;
      counterpart.set(a.id, ids);
      counterpart.set(b.id, ids);
    };
    const twin = (agent: Agent, cli: AgentCli): Agent => {
      const name = freeTwinName(agent.name, cli, taken);
      taken.add(name);
      // Model ids and override syntax differ per CLI, so the twin starts without them.
      return agents.create({
        name,
        cli,
        model: null,
        prompt: agent.prompt,
        eligibleStages: [...agent.eligibleStages],
        permissionOverrides: {},
      });
    };
    // Claude Code agents first, so an existing `X` / `X (Copilot)` pair is not twinned twice.
    for (const cli of AGENT_CLIS) {
      const target = otherCli(cli);
      for (const agent of library) {
        if (agent.cli !== cli || counterpart.has(agent.id)) continue;
        const named = byName.get(`${agent.name} (${CLI_TWIN_SUFFIX[target]})`);
        pair(
          agent,
          named?.cli === target && !counterpart.has(named.id) ? named : twin(agent, target),
        );
      }
    }

    /** Each agent's counterpart on `cli`, if it may still fill the role. */
    const mapRoles = (roles: RoleAgents, cli: AgentCli): RoleAgents =>
      mapRoleIds(roles, (role, id) => {
        const mapped = counterpart.get(id)?.[cli];
        const agent = mapped === undefined ? undefined : agents.get(mapped);
        return agent?.eligibleStages.includes(ROLE_STAGES[role]) ? agent.id : undefined;
      });
    const current = roleDefaults("claude");
    settings.set(ROLE_DEFAULTS_KEYS.claude, mapRoles(current, "claude"));
    if (settings.get(ROLE_DEFAULTS_KEYS.copilot) === undefined) {
      settings.set(ROLE_DEFAULTS_KEYS.copilot, mapRoles(current, "copilot"));
    }

    for (const item of backlogItems.list()) {
      if (item.status === "promoted") continue;
      const roles = mapRoles(item.agents, repos.get(item.repoId)?.defaultCli ?? "claude");
      if (!sameRoles(roles, item.agents)) backlogItems.update(item.id, { agents: roles });
    }
    settings.set(CLI_TWINS_SEEDED_KEY, true);
  }

  return {
    list: (): Agent[] => agents.list(),

    get: existing,

    create(input: AgentInput): Agent {
      const parsed = agentInputSchema.safeParse(input);
      if (!parsed.success) throw invalid(parsed.error);
      assertUniqueName(parsed.data.name);
      return agents.create(parsed.data);
    },

    update(id: string, patch: AgentUpdate): Agent {
      existing(id);
      const parsed = agentUpdateSchema.safeParse(patch);
      if (!parsed.success) throw invalid(parsed.error);
      if (parsed.data.name !== undefined) assertUniqueName(parsed.data.name, id);
      const fields = Object.fromEntries(
        Object.entries(parsed.data).filter(([, value]) => value !== undefined),
      );
      const updated = agents.update(id, fields);
      // A default the agent is no longer eligible for would fail every new task.
      pruneRoleDefaults(
        (role, agentId) => agentId !== id || updated.eligibleStages.includes(ROLE_STAGES[role]),
      );
      return updated;
    },

    /** Deletes an agent and removes it from the role defaults. Past steps keep a null agent. */
    delete(id: string): void {
      existing(id);
      agents.delete(id);
      pruneRoleDefaults((_, agentId) => agentId !== id);
    },

    roleDefaults,

    /** The role defaults of every CLI. */
    allRoleDefaults: (): RoleDefaultsByCli => ({
      claude: roleDefaults("claude"),
      copilot: roleDefaults("copilot"),
    }),

    /** Replaces one CLI's role defaults. */
    setRoleDefaults(input: RoleAgents, cli: AgentCli = "claude"): RoleAgents {
      const roles = checkRoles(input);
      settings.set(ROLE_DEFAULTS_KEYS[cli], roles);
      return roles;
    },

    resolveRoles,

    /**
     * The CLIs the agents of a new task would run on (the role defaults of
     * `cli` with `overrides` on top); unknown agents are left out.
     */
    clisFor(overrides: RoleAgents = {}, cli: AgentCli = "claude"): AgentCli[] {
      const roles = resolveRoles(overrides, cli);
      const ids = AGENT_ROLES.flatMap((role) => roleIds(roles, role));
      return [...new Set(ids.flatMap((id) => agents.get(id)?.cli ?? []))];
    },

    /**
     * What an agent gets for a stage: its system prompt (code reviewers also get
     * the current tags and the findings contract) and the permissions of the
     * stage's profile plus the agent's overrides.
     */
    invocation(agentId: string, stage: Stage): AgentInvocation {
      const agent = existing(agentId);
      assertEligible(agent, stage);
      const profile = stagePermissionProfile(stage);
      return {
        agent,
        stage,
        systemPrompt: buildSystemPrompt({ agent, stage, profile, tags: tags.names() }),
        permissions: permissionsFor(agent.cli, profile, agent.permissionOverrides),
      };
    },

    /**
     * Adds the built-in agents, their twins on the other CLI, the role defaults
     * and the finding tags on first start. Each is seeded once, so agents or
     * tags the user deletes stay deleted.
     */
    seed(): void {
      upgradeSeedPrompts();
      if (settings.get(AGENTS_SEEDED_KEY) !== true) {
        const byName = new Map(agents.list().map((a) => [a.name, a]));
        for (const seed of SEED_AGENTS) {
          if (!byName.has(seed.name)) {
            byName.set(
              seed.name,
              agents.create({ ...seed, eligibleStages: [...seed.eligibleStages] }),
            );
          }
        }
        const idOf = (name: string) => byName.get(name)?.id;
        const ids = (names: readonly string[]) =>
          names.map(idOf).filter((id): id is string => id !== undefined);
        if (settings.get(ROLE_DEFAULTS_KEYS.claude) === undefined) {
          settings.set(ROLE_DEFAULTS_KEYS.claude, {
            planner: idOf(SEED_ROLE_DEFAULTS.planner),
            planReviewers: ids(SEED_ROLE_DEFAULTS.planReviewers),
            implementer: idOf(SEED_ROLE_DEFAULTS.implementer),
            codeReviewers: ids(SEED_ROLE_DEFAULTS.codeReviewers),
            summarizer: idOf(SEED_ROLE_DEFAULTS.summarizer),
          } satisfies RoleAgents);
        }
        settings.set(AGENTS_SEEDED_KEY, true);
      }
      seedCliTwins();
      if (settings.get(TAGS_SEEDED_KEY) !== true) {
        if (tags.list().length === 0) tags.replace(DEFAULT_TAGS);
        settings.set(TAGS_SEEDED_KEY, true);
      }
    },
  };
}
