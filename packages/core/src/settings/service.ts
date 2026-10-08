import {
  DEFAULT_MAX_TASKS_PER_REPO,
  generalSettingsSchema,
  generalSettingsUpdateSchema,
  tagListInputSchema,
  type GeneralSettings,
  type GeneralSettingsUpdate,
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
  function general(): GeneralSettings {
    const parsed = generalSettingsSchema.safeParse({
      maxTasksPerRepo: settings.get(MAX_TASKS_PER_REPO_KEY),
    });
    return parsed.success ? parsed.data : { maxTasksPerRepo: DEFAULT_MAX_TASKS_PER_REPO };
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
      if (parsed.data.maxTasksPerRepo !== undefined) {
        settings.set(MAX_TASKS_PER_REPO_KEY, parsed.data.maxTasksPerRepo);
      }
      return general();
    },
  };
}
