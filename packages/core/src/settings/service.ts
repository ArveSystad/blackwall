import {
  generalSettingsSchema,
  generalSettingsUpdateSchema,
  repoBacklogRunnerSchema,
  tagListInputSchema,
  type GeneralSettings,
  type GeneralSettingsUpdate,
  type RepoBacklogRunner,
  type TagListInput,
} from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";

/** Rejected settings or tag input. Safe to show the user. */
export class InvalidSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSettingsError";
  }
}

/** Settings key holding the concurrency cap per repo. */
export const MAX_TASKS_PER_REPO_KEY = "maxTasksPerRepo";

/** Settings keys of the general settings, one per field. */
const GENERAL_KEYS = [
  MAX_TASKS_PER_REPO_KEY,
  "backlogRunner",
  "maxBacklogTasksPerRepo",
  "stopBacklogOnNeedsYou",
] as const satisfies readonly (keyof GeneralSettings)[];

/** Settings key of a repo's backlog runner state. */
export const repoBacklogRunnerKey = (repoId: string) => `backlogRunner:${repoId}`;

export interface SettingsServiceOptions {
  settings: Repositories["settings"];
  tags: Repositories["tags"];
}

export type SettingsService = ReturnType<typeof createSettingsService>;

function invalid(error: { issues: readonly { message: string }[] }): InvalidSettingsError {
  return new InvalidSettingsError(error.issues.map((issue) => issue.message).join("; "));
}

/**
 * App-wide settings that are not about agents: the finding tags injected into
 * reviewer prompts and the concurrency cap per repo. Role defaults live in the
 * agent service.
 */
export function createSettingsService({ settings, tags }: SettingsServiceOptions) {
  /** Each field on its own, so one bad stored value falls back alone. */
  function general(): GeneralSettings {
    const defaults = generalSettingsSchema.parse({});
    const values: Record<string, unknown> = { ...defaults };
    for (const key of GENERAL_KEYS) {
      const field = generalSettingsSchema.shape[key].safeParse(settings.get(key));
      if (field.success) values[key] = field.data;
    }
    return generalSettingsSchema.parse(values);
  }

  function repoBacklogRunner(repoId: string): RepoBacklogRunner {
    const parsed = repoBacklogRunnerSchema.safeParse(
      settings.get(repoBacklogRunnerKey(repoId)) ?? {},
    );
    return parsed.success ? parsed.data : repoBacklogRunnerSchema.parse({});
  }

  function saveRepoBacklogRunner(repoId: string, value: RepoBacklogRunner): RepoBacklogRunner {
    settings.set(repoBacklogRunnerKey(repoId), {
      enabled: value.enabled,
      haltedTaskId: value.haltedTaskId,
      haltedAt: value.haltedAt?.toISOString() ?? null,
    });
    return repoBacklogRunner(repoId);
  }

  return {
    /** Tag names in display order. */
    tags: (): string[] => tags.names(),

    /** Replaces the tag list; new reviewer steps get the new list. */
    setTags(input: TagListInput): string[] {
      const parsed = tagListInputSchema.safeParse(input);
      if (!parsed.success) throw invalid(parsed.error);
      tags.replace(parsed.data.tags);
      return tags.names();
    },

    general,

    /** How many tasks may run at once in one repo (default 3). */
    maxTasksPerRepo: (): number => general().maxTasksPerRepo,

    updateGeneral(patch: GeneralSettingsUpdate): GeneralSettings {
      const parsed = generalSettingsUpdateSchema.safeParse(patch);
      if (!parsed.success) throw invalid(parsed.error);
      for (const key of GENERAL_KEYS) {
        const value = parsed.data[key];
        if (value !== undefined) settings.set(key, value);
      }
      return general();
    },

    /** A repo's backlog runner switch and halt (on and not halted by default). */
    repoBacklogRunner,

    /** Switches a repo's backlog runner on or off. */
    setRepoBacklogRunnerEnabled(repoId: string, enabled: boolean): RepoBacklogRunner {
      return saveRepoBacklogRunner(repoId, { ...repoBacklogRunner(repoId), enabled });
    },

    /** Halts a repo's backlog runner on a failed backlog task, or clears the halt (`null`). */
    setRepoBacklogHalt(repoId: string, taskId: string | null, at = new Date()): RepoBacklogRunner {
      return saveRepoBacklogRunner(repoId, {
        ...repoBacklogRunner(repoId),
        haltedTaskId: taskId,
        haltedAt: taskId === null ? null : at,
      });
    },
  };
}
