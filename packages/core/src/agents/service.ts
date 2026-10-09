import {
  AGENT_ROLES,
  DEFAULT_TAGS,
  ROLE_STAGES,
  agentInputSchema,
  agentUpdateSchema,
  roleAgentsSchema,
  stagePermissionProfile,
  type Agent,
  type AgentInput,
  type AgentRole,
  type AgentUpdate,
  type RoleAgents,
  type Stage,
} from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";
import { permissionsFor, type AgentPermissions } from "./permissions.js";
import { buildSystemPrompt } from "./prompts.js";
import { LEGACY_SEED_PROMPTS, SEED_AGENTS, SEED_ROLE_DEFAULTS } from "./seeds.js";

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

/** Settings key holding the default agent per role. */
export const ROLE_DEFAULTS_KEY = "roleDefaults";
/** Settings keys recording that the built-in agents and tags were seeded, so deleting them sticks. */
export const AGENTS_SEEDED_KEY = "seeded.agents";
export const TAGS_SEEDED_KEY = "seeded.tags";

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

/**
 * The agent library: user-managed agents (CLI, model, persona, eligible stages,
 * permission overrides), the default agent per pipeline role, and the prompt and
 * permissions an agent gets for a stage.
 */
export function createAgentService({ agents, settings, tags }: AgentServiceOptions) {
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

  function roleDefaults(): RoleAgents {
    const parsed = roleAgentsSchema.safeParse(settings.get(ROLE_DEFAULTS_KEY) ?? {});
    return parsed.success ? parsed.data : {};
  }

  /** Drops an agent from the role defaults (after it is deleted or no longer eligible). */
  function pruneRoleDefaults(keep: (role: AgentRole, id: string) => boolean): void {
    const current = roleDefaults();
    const next: RoleAgents = {};
    for (const role of AGENT_ROLES) {
      const value = current[role];
      if (value === undefined) continue;
      if (typeof value === "string") {
        if (keep(role, value)) Object.assign(next, { [role]: value });
      } else {
        Object.assign(next, { [role]: value.filter((id) => keep(role, id)) });
      }
    }
    settings.set(ROLE_DEFAULTS_KEY, next);
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

    setRoleDefaults(input: RoleAgents): RoleAgents {
      const roles = checkRoles(input);
      settings.set(ROLE_DEFAULTS_KEY, roles);
      return roles;
    },

    /**
     * The agents for a new task: the role defaults with the new-task form's
     * choices on top. Validated like the defaults.
     */
    resolveRoles(overrides: RoleAgents = {}): RoleAgents {
      const chosen = Object.fromEntries(
        Object.entries(checkRoles(overrides)).filter(([, value]) => value !== undefined),
      );
      return { ...roleDefaults(), ...chosen };
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
     * Adds the built-in agents, role defaults and finding tags on first start.
     * Each is seeded once, so agents or tags the user deletes stay deleted.
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
        if (settings.get(ROLE_DEFAULTS_KEY) === undefined) {
          settings.set(ROLE_DEFAULTS_KEY, {
            planner: idOf(SEED_ROLE_DEFAULTS.planner),
            planReviewers: ids(SEED_ROLE_DEFAULTS.planReviewers),
            implementer: idOf(SEED_ROLE_DEFAULTS.implementer),
            codeReviewers: ids(SEED_ROLE_DEFAULTS.codeReviewers),
            summarizer: idOf(SEED_ROLE_DEFAULTS.summarizer),
          } satisfies RoleAgents);
        }
        settings.set(AGENTS_SEEDED_KEY, true);
      }
      if (settings.get(TAGS_SEEDED_KEY) !== true) {
        if (tags.list().length === 0) tags.replace(DEFAULT_TAGS);
        settings.set(TAGS_SEEDED_KEY, true);
      }
    },
  };
}
