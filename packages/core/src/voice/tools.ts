import { randomUUID } from "node:crypto";
import {
  MAX_TITLE_CHARS,
  type BacklogItem,
  type GeneralSettings,
  type RepoBacklogRunner,
  type Task,
  type VoiceDraft,
} from "@blackwall/shared";
import { z } from "zod";
import type { Repositories } from "../db/repositories.js";

/** A tool call the agent should hear about: its message is the tool's error result. */
export class VoiceToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceToolError";
  }
}

/** What a voice tool may touch: the turn's repo, the shared draft and the backlog. */
export interface VoiceToolContext {
  /** The repo of the voice turn the call belongs to. */
  repoId: string;
  /** The open draft; `set` publishes it. */
  draft: { get(): VoiceDraft | null; set(draft: VoiceDraft | null): void };
  /** Creates the draft's task exactly once; see `VoiceCommandService.submitDraft`. */
  submitDraft(id: string): Promise<BacklogItem>;
  /** Promotes a waiting backlog item to a task now. */
  runBacklogItem(repoId: string, itemId: string): Task;
  backlogItems: Pick<Repositories["backlogItems"], "list">;
  runner: {
    general(): Pick<GeneralSettings, "backlogRunner">;
    repoBacklogRunner(repoId: string): RepoBacklogRunner;
    setRepoBacklogRunnerEnabled(repoId: string, enabled: boolean): RepoBacklogRunner;
  };
  /** Announces a backlog change to clients and the backlog runner. */
  publishBacklogChanged(repoId: string): void;
}

/** A tool on the blackwall MCP server: what the agent sees, and what it does. */
export interface VoiceTool {
  name: string;
  description: string;
  input: z.ZodObject;
  /** Validates `input`, acts, and returns a short sentence; throws {@link VoiceToolError}. */
  run(ctx: VoiceToolContext, input: unknown): Promise<string>;
}

function tool<S extends z.ZodObject>(spec: {
  name: string;
  description: string;
  input: S;
  run(ctx: VoiceToolContext, input: z.infer<S>): Promise<string> | string;
}): VoiceTool {
  return {
    name: spec.name,
    description: spec.description,
    input: spec.input,
    async run(ctx, raw) {
      const parsed = spec.input.safeParse(raw ?? {});
      if (!parsed.success) {
        throw new VoiceToolError(parsed.error.issues[0]?.message ?? "Invalid input");
      }
      return spec.run(ctx, parsed.data);
    },
  };
}

const title = z.string().trim().min(1, "Give the task a title").max(MAX_TITLE_CHARS);

/** The open draft, unless it is missing or being created. */
function editableDraft(ctx: VoiceToolContext): VoiceDraft {
  const draft = ctx.draft.get();
  if (!draft) throw new VoiceToolError("There is no task draft open; create a task first");
  if (draft.submitting) throw new VoiceToolError("The task is already being created");
  return draft;
}

const createTask = tool({
  name: "create_task",
  description:
    "Open the New task form for this repo with a title and an optional description, replacing any open draft. Nothing is created until submit_task_draft.",
  input: z.object({
    title,
    description: z.string().optional().describe("What the task should do, when the user said"),
  }),
  run(ctx, input) {
    if (ctx.draft.get()?.submitting) {
      throw new VoiceToolError("The open task is still being created; try again in a moment");
    }
    ctx.draft.set({
      id: randomUUID(),
      repoId: ctx.repoId,
      title: input.title,
      description: input.description?.trim() ?? "",
      revision: 0,
      submitting: false,
    });
    return `Opened the New task form with '${input.title}'.`;
  },
});

const updateTaskDraft = tool({
  name: "update_task_draft",
  description:
    "Change the open task draft: replace its title or description, or append to the description.",
  input: z.object({
    title: title.optional(),
    description: z.string().optional().describe("Replaces the description"),
    append_description: z.string().optional().describe("Added to the end of the description"),
  }),
  run(ctx, input) {
    const draft = editableDraft(ctx);
    let description = input.description?.trim() ?? draft.description;
    const extra = input.append_description?.trim();
    if (extra) description = description ? `${description}\n\n${extra}` : extra;
    const next = { ...draft, title: input.title ?? draft.title, description };
    if (next.title === draft.title && next.description === draft.description) {
      return "The draft is unchanged.";
    }
    ctx.draft.set({ ...next, revision: draft.revision + 1 });
    return `Updated the draft '${next.title}'.`;
  },
});

const submitTaskDraft = tool({
  name: "submit_task_draft",
  description:
    "Create and start the task in the open draft, once. Call it when the user confirms the draft.",
  input: z.object({}),
  async run(ctx) {
    const draft = ctx.draft.get();
    if (!draft) throw new VoiceToolError("There is no task draft open; create a task first");
    if (!draft.description.trim()) {
      throw new VoiceToolError(
        "The draft has no description; ask the user to describe the task first",
      );
    }
    let item: BacklogItem;
    try {
      item = await ctx.submitDraft(draft.id);
    } catch (error) {
      throw new VoiceToolError(
        error instanceof Error ? error.message : "Could not create the task",
      );
    }
    return item.taskId
      ? `Created and started task '${item.title}'.`
      : `Added '${item.title}' to the backlog; it starts when the backlog runner picks it.`;
  },
});

const runBacklogItem = tool({
  name: "run_backlog_item",
  description: "Start a waiting backlog item of this repo now, by its id from the state block.",
  input: z.object({ item_id: z.string().min(1) }),
  run(ctx, input) {
    const item = ctx.backlogItems.list(ctx.repoId).find((i) => i.id === input.item_id);
    if (!item) throw new VoiceToolError(`No backlog item ${input.item_id} in this repo`);
    if (item.status !== "waiting") {
      throw new VoiceToolError(`'${item.title}' is not waiting in the backlog (${item.status})`);
    }
    ctx.runBacklogItem(ctx.repoId, item.id);
    return `Started '${item.title}'.`;
  },
});

const setBacklogRunner = tool({
  name: "set_backlog_runner",
  description: 'Turn "Run this repo\'s backlog" on or off for this repo.',
  input: z.object({ enabled: z.boolean() }),
  run(ctx, { enabled }) {
    ctx.runner.setRepoBacklogRunnerEnabled(ctx.repoId, enabled);
    ctx.publishBacklogChanged(ctx.repoId);
    if (!enabled) return "Turned the backlog runner off for this repo.";
    return ctx.runner.general().backlogRunner
      ? "Turned the backlog runner on for this repo."
      : "Turned the backlog runner on for this repo. The runner is off for every repo in Settings, so nothing runs until it is turned on there.";
  },
});

/** The tools on the blackwall MCP server, in the order the agent sees them. */
export const VOICE_TOOLS: readonly VoiceTool[] = [
  createTask,
  updateTaskDraft,
  submitTaskDraft,
  runBacklogItem,
  setBacklogRunner,
];

export const VOICE_TOOL_NAMES: readonly string[] = VOICE_TOOLS.map((t) => t.name);
