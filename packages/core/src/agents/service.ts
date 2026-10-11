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
  type AgentClis,
  type AgentInput,
  type AgentModels,
  type AgentPermissionOverrides,
  type AgentRole,
  type AgentUpdate,
  type RoleAgents,
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

/** Settings key holding the default agent per role. */
export const ROLE_DEFAULTS_KEY = "roleDefaults";
/** Settings keys recording that the built-in agents and tags were seeded, so deleting them sticks. */
export const AGENTS_SEEDED_KEY = "seeded.agents";
export const TAGS_SEEDED_KEY = "seeded.tags";
/** Settings key recording that the per-CLI agent twins were merged into their base agents. */
export const CLI_TWINS_MERGED_KEY = "seeded.mergedCliTwins";
/** Settings keys of the per-CLI agents, left behind by earlier versions and removed by the merge. */
const LEGACY_COPILOT_ROLE_DEFAULTS_KEY = "roleDefaults.copilot";
const LEGACY_CLI_TWINS_SEEDED_KEY = "seeded.cliTwins";

/** Everything a step needs to invoke an agent: its persona, prompt, CLI, model and permissions. */
export interface AgentInvocation {
  agent: Agent;
  stage: Stage;
  cli: AgentCli;
  /** The agent's model on `cli`; null runs the CLI's default model. */
  model: string | null;
  systemPrompt: string;
  permissions: AgentPermissions;
}

export interface AgentServiceOptions {
  agents: Repositories["agents"];
  settings: Repositories["settings"];
  tags: Repositories["tags"];
  repos: Repositories["repos"];
  tasks: Repositories["tasks"];
  backlogItems: Repositories["backlogItems"];
  /** Runs `fn` in one database transaction. */
  transaction: Repositories["transaction"];
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

/** Every agent id in a role set, each once. */
function allRoleIds(roles: RoleAgents): string[] {
  return [...new Set(AGENT_ROLES.flatMap((role) => roleIds(roles, role)))];
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

/**
 * The per-agent CLI choices worth storing for a task: those for agents in
 * `roles` that differ from the task's `cli`.
 */
export function resolveClis(roles: RoleAgents, agentClis: AgentClis, cli: AgentCli): AgentClis {
  const listed = new Set(allRoleIds(roles));
  return Object.fromEntries(
    Object.entries(agentClis).filter(([id, value]) => listed.has(id) && value !== cli),
  );
}

const TWIN_NAME = new RegExp(
  String.raw`^(.*) \((${Object.values(CLI_TWIN_SUFFIX).join("|")})(?: (\d+))?\)$`,
);

/**
 * What a twin's name says: its base agent's name, the CLI the twin was made
 * for, and its number (1 when unnumbered). `X (Copilot 2)` is `X`'s second
 * Copilot CLI twin; `X (Claude)` is the Claude Code twin of a Copilot agent `X`.
 */
function twinBase(name: string): { base: string; side: AgentCli; n: number } | undefined {
  const match = TWIN_NAME.exec(name);
  if (!match) return undefined;
  const [, base, suffix, n] = match;
  const side = (Object.entries(CLI_TWIN_SUFFIX) as [AgentCli, string][]).find(
    ([, value]) => value === suffix,
  )?.[0];
  if (base === undefined || side === undefined) return undefined;
  return { base, side, n: n === undefined ? 1 : Number(n) };
}

/**
 * A base agent and its twins, Claude Code side first: `(Claude…)` twins by
 * number, then the base, then `(Copilot…)` twins by number. Where the twins
 * differ, the first one wins.
 */
function groupOrder(base: Agent, candidates: readonly Agent[]): Agent[] {
  const ranked = candidates.map((agent) => {
    const twin = twinBase(agent.name);
    return { agent, rank: twin?.side === "claude" ? -1 : 1, n: twin?.n ?? 1 };
  });
  ranked.sort((a, b) => a.rank - b.rank || a.n - b.n || a.agent.name.localeCompare(b.agent.name));
  return [
    ...ranked.filter((r) => r.rank < 0).map((r) => r.agent),
    base,
    ...ranked.filter((r) => r.rank > 0).map((r) => r.agent),
  ];
}

/**
 * The fields of the agent a group merges into: the first member's prompt and
 * stages, and per CLI the first member's model and permission overrides.
 */
function mergedAgent(
  group: readonly Agent[],
): Pick<Agent, "prompt" | "eligibleStages" | "models" | "permissionOverrides"> {
  const [first] = group;
  if (!first) throw new Error("An agent group needs at least one agent");
  const models: AgentModels = {};
  const permissionOverrides: AgentPermissionOverrides = {};
  for (const cli of AGENT_CLIS) {
    const model = group.find((a) => a.models[cli] !== undefined)?.models[cli];
    if (model !== undefined) models[cli] = model;
    const overrides = group.find((a) => a.permissionOverrides[cli] !== undefined)
      ?.permissionOverrides[cli];
    if (overrides !== undefined) permissionOverrides[cli] = overrides;
  }
  return {
    prompt: first.prompt,
    eligibleStages: [...first.eligibleStages],
    models,
    permissionOverrides,
  };
}

/**
 * A row's CLI choices once `group` is merged into `base`: the choice of the
 * first member (in precedence order) the row lists in any role moves to the
 * base, where no entry means the row's `cli`. The other members' entries go,
 * and choices equal to `cli` are dropped.
 */
function mergeAgentClis(
  agentClis: AgentClis,
  listedIds: ReadonlySet<string>,
  group: readonly Agent[],
  base: Agent,
  cli: AgentCli,
): AgentClis {
  const members = new Set(group.map((a) => a.id));
  const next: AgentClis = Object.fromEntries(
    Object.entries(agentClis).filter(([id]) => !members.has(id)),
  );
  const chosen = group.find((a) => listedIds.has(a.id));
  if (chosen) next[base.id] = agentClis[chosen.id] ?? cli;
  return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== cli));
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The agent library: user-managed agents (persona, eligible stages, and per
 * CLI a model and permission overrides), the default agent per pipeline role,
 * and the prompt and permissions an agent gets for a stage on a CLI.
 */
export function createAgentService({
  agents,
  settings,
  tags,
  repos,
  tasks,
  backlogItems,
  transaction,
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

  function roleDefaults(): RoleAgents {
    const parsed = roleAgentsSchema.safeParse(settings.get(ROLE_DEFAULTS_KEY) ?? {});
    return parsed.success ? parsed.data : {};
  }

  /** Drops an agent from the role defaults (after it is deleted or no longer eligible). */
  function pruneRoleDefaults(keep: (role: AgentRole, id: string) => boolean): void {
    // Unset defaults are left unset, so seeding can still derive them.
    if (settings.get(ROLE_DEFAULTS_KEY) === undefined) return;
    settings.set(
      ROLE_DEFAULTS_KEY,
      mapRoleIds(roleDefaults(), (role, id) => (keep(role, id) ? id : undefined)),
    );
  }

  /**
   * The agents for a new task: the role defaults with the new-task form's
   * choices on top. Validated like the defaults.
   */
  function resolveRoles(overrides: RoleAgents = {}): RoleAgents {
    const chosen = Object.fromEntries(
      Object.entries(checkRoles(overrides)).filter(([, value]) => value !== undefined),
    );
    return { ...roleDefaults(), ...chosen };
  }

  /** The base agent a twin finally resolves to, following twins of twins; none for a non-twin. */
  function baseOf(agent: Agent, byName: ReadonlyMap<string, Agent>): Agent | undefined {
    let base: Agent | undefined;
    const seen = new Set<string>();
    for (let name = agent.name; !seen.has(name);) {
      seen.add(name);
      const next = byName.get(twinBase(name)?.base ?? "");
      if (!next) break;
      base = next;
      name = next.name;
    }
    return base;
  }

  /**
   * Folds every per-CLI twin left by earlier versions (`X (Copilot)`,
   * `X (Copilot 2)`, `X (Claude)`, …) into its base agent `X`, which keeps
   * its id and name. Where the copies differ, the Claude Code side wins (see
   * {@link groupOrder}). Tasks, backlog items, role defaults, steps, findings
   * and grill questions that name a twin name `X` instead. Twins whose base
   * no longer exists are left alone. Runs once, in one transaction.
   */
  function mergeCliTwins(): void {
    if (settings.get(CLI_TWINS_MERGED_KEY) === true) return;
    transaction(() => {
      const library = agents.list();
      const byName = new Map(library.map((a) => [a.name, a]));
      const twins = new Map<Agent, Agent[]>();
      for (const agent of library) {
        const base = baseOf(agent, byName);
        if (base) twins.set(base, [...(twins.get(base) ?? []), agent]);
      }
      const groups = [...twins].map(([base, candidates]) => ({
        base,
        members: groupOrder(base, candidates),
      }));

      const merged = new Map<string, Agent>();
      const mergedInto = new Map<string, string>();
      for (const { base, members } of groups) {
        merged.set(base.id, agents.update(base.id, mergedAgent(members)));
        for (const member of members) mergedInto.set(member.id, base.id);
      }
      const toBase = (_: AgentRole, id: string) => mergedInto.get(id) ?? id;
      /** Also drops a merged agent from roles its merged stages no longer cover. */
      const toEligibleBase = (role: AgentRole, id: string) => {
        const base = toBase(role, id);
        const agent = merged.get(base);
        return !agent || agent.eligibleStages.includes(ROLE_STAGES[role]) ? base : undefined;
      };
      const mergeClis = (roles: RoleAgents, agentClis: AgentClis, cli: AgentCli) => {
        const listed = new Set(allRoleIds(roles));
        return groups.reduce(
          (clis, { base, members }) => mergeAgentClis(clis, listed, members, base, cli),
          agentClis,
        );
      };

      if (groups.length > 0) {
        // Tasks are history, so they keep the merged agent in every role.
        for (const task of tasks.list()) {
          const roles = mapRoleIds(task.agents, toBase);
          const agentClis = mergeClis(task.agents, task.agentClis, task.cli);
          if (!sameJson(roles, task.agents) || !sameJson(agentClis, task.agentClis)) {
            tasks.update(task.id, { agents: roles, agentClis });
          }
        }
        // Backlog items must still promote, so they drop roles the merged agent lost.
        for (const item of backlogItems.list()) {
          const cli = repos.get(item.repoId)?.defaultCli ?? "claude";
          const roles = mapRoleIds(item.agents, toEligibleBase);
          const agentClis = resolveClis(roles, mergeClis(item.agents, item.agentClis, cli), cli);
          if (!sameJson(roles, item.agents) || !sameJson(agentClis, item.agentClis)) {
            backlogItems.update(item.id, { agents: roles, agentClis });
          }
        }
        if (settings.get(ROLE_DEFAULTS_KEY) !== undefined) {
          settings.set(ROLE_DEFAULTS_KEY, mapRoleIds(roleDefaults(), toEligibleBase));
        }
        for (const { base, members } of groups) {
          for (const member of members) {
            if (member.id === base.id) continue;
            agents.reassign(member.id, base.id);
            agents.delete(member.id);
          }
        }
      }
      settings.delete(LEGACY_COPILOT_ROLE_DEFAULTS_KEY);
      settings.delete(LEGACY_CLI_TWINS_SEEDED_KEY);
      settings.set(CLI_TWINS_MERGED_KEY, true);
    });
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

    /** Replaces the role defaults. */
    setRoleDefaults(input: RoleAgents): RoleAgents {
      const roles = checkRoles(input);
      settings.set(ROLE_DEFAULTS_KEY, roles);
      return roles;
    },

    resolveRoles,

    resolveClis,

    /**
     * The CLIs a task's agents run on: `cli` for every agent in `roles`
     * without a choice in `agentClis`, plus the chosen CLIs.
     */
    clisFor(roles: RoleAgents, agentClis: AgentClis, cli: AgentCli): AgentCli[] {
      return [...new Set(allRoleIds(roles).map((id) => agentClis[id] ?? cli))];
    },

    /**
     * What an agent gets for a stage on a CLI: its system prompt (code
     * reviewers also get the current tags and the findings contract), its
     * model on that CLI, and the permissions of the stage's profile plus the
     * agent's overrides for that CLI.
     */
    invocation(agentId: string, stage: Stage, cli: AgentCli): AgentInvocation {
      const agent = existing(agentId);
      assertEligible(agent, stage);
      const profile = stagePermissionProfile(stage);
      return {
        agent,
        stage,
        cli,
        model: agent.models[cli] ?? null,
        systemPrompt: buildSystemPrompt({ agent, stage, profile, tags: tags.names() }),
        permissions: permissionsFor(cli, profile, agent.permissionOverrides[cli]),
      };
    },

    /**
     * Adds the built-in agents, the role defaults and the finding tags on
     * first start, and merges the per-CLI twins of earlier versions. Each
     * runs once, so agents or tags the user deletes stay deleted.
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
      mergeCliTwins();
      if (settings.get(TAGS_SEEDED_KEY) !== true) {
        if (tags.list().length === 0) tags.replace(DEFAULT_TAGS);
        settings.set(TAGS_SEEDED_KEY, true);
      }
    },
  };
}
