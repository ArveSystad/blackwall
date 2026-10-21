import { describe, expect, it } from "vitest";
import {
  repoBacklogRunnerSchema,
  repoBacklogRunnerUpdateSchema,
  stepSchema,
  chatActionProposalSchema,
  chatReplyJsonSchema,
  chatReplySchema,
  chatSendInputSchema,
  chatStateSchema,
  taskResumeInputSchema,
  assignedIssuesSchema,
  repoIssuesSchema,
  deliveryConfirmationSchema,
  gateResponseInputSchema,
  githubPrOriginSchema,
  shortSummarySchema,
  summaryCoreSchema,
  summaryOutputJsonSchema,
  summaryOutputSchema,
  MAX_FOLLOW_UPS,
  ROLE_STAGES,
  agentCliFor,
  backlogCapFor,
  ciNeedsYou,
  effectiveTrust,
  LOCKED_TRUST,
  agentPermissionOverridesSchema,
  agentInputSchema,
  agentUpdateSchema,
  AGENT_EFFORT_LEVELS,
  effortFlagApplies,
  connectionInputSchema,
  connectionViewSchema,
  deliveryActionSchema,
  diffCommentInputSchema,
  diffCommentsInputSchema,
  findingSchema,
  grillQuestionSchema,
  isGatingSeverity,
  isUserComment,
  newBacklogItemInputSchema,
  newTaskInputSchema,
  parseFollowUps,
  planAnswersOutputJsonSchema,
  planAnswersOutputSchema,
  planReviewOutputJsonSchema,
  planReviewOutputSchema,
  reorderReposInputSchema,
  repoInputSchema,
  repoScanInputSchema,
  repoUpdateSchema,
  reviewOutputJsonSchema,
  reviewOutputSchema,
  reviewRequestsSchema,
  searchQuerySchema,
  searchResultsSchema,
  settingsSchema,
  stagePermissionProfile,
  taskSchema,
  updateBacklogItemInputSchema,
  generalSettingsUpdateSchema,
  MAX_VOICE_COMMAND_CHARS,
  VOICE_MODEL_FILES,
  VOICE_MODEL_IDS,
  VOICE_MODELS,
  voiceCommandInputSchema,
  voiceDownloadInputSchema,
  voiceHotkeyLabel,
  voiceHotkeySchema,
  voiceStateSchema,
  type CiState,
  type TaskCi,
  originRef,
} from "./domain.js";

const now = "2026-10-08T10:00:00.000Z";

const task = {
  id: "t1",
  title: "Fix login",
  origin: { kind: "jira-issue", key: "ABC-123", connectionId: "c1" },
  mode: null,
  prBranch: null,
  repoId: "r1",
  branch: "feature/abc-123-fix-login",
  baseBranch: null,
  worktreePath: null,
  status: "needs-you",
  stage: "plan-review",
  gate: "plan-approval",
  error: null,
  triageMode: "intervene",
  agents: { planner: "a1", codeReviewers: ["a2", "a3"] },
  cli: "copilot",
  agentClis: { a2: "claude" },
  referenceRepoIds: ["r2"],
  deliveryTargets: ["push-branch", "open-pr", "jira-comment"],
  delivering: false,
  freeText: "",
  plan: null,
  summary: null,
  shortSummary: null,
  squashMessage: null,
  followUps: [],
  archivedAt: null,
  ci: null,
  createdAt: now,
  updatedAt: now,
};

describe("originRef", () => {
  it("is the Jira key for a Jira issue", () => {
    expect(originRef({ kind: "jira-issue", key: "ABC-1", connectionId: null })).toBe("ABC-1");
  });

  it("is owner/repo#number for a pull request", () => {
    const pr = { url: "https://github.com/acme/web/pull/7", owner: "acme", repo: "web", number: 7 };
    expect(originRef({ kind: "github-pr", ...pr, connectionId: null })).toBe("acme/web#7");
  });

  it("is owner/repo#number for a GitHub issue", () => {
    const issue = {
      url: "https://github.com/acme/web/issues/7",
      owner: "acme",
      repo: "web",
      number: 7,
    };
    expect(originRef({ kind: "github-issue", ...issue, connectionId: null })).toBe("acme/web#7");
  });
});

describe("ciNeedsYou", () => {
  const ci = (state: CiState): TaskCi => ({
    state,
    sha: "abc1234",
    host: "github.com",
    owner: "acme",
    repo: "web",
    checks: [],
    hint: null,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
  });

  it("is true for a done, listed task whose CI failed", () => {
    expect(ciNeedsYou({ status: "done", archivedAt: null, ci: ci("failed") })).toBe(true);
  });

  it("is false once archived, while running again, or when CI did not fail", () => {
    expect(ciNeedsYou({ status: "done", archivedAt: new Date(), ci: ci("failed") })).toBe(false);
    expect(ciNeedsYou({ status: "running", archivedAt: null, ci: ci("failed") })).toBe(false);
    expect(ciNeedsYou({ status: "done", archivedAt: null, ci: ci("passed") })).toBe(false);
    expect(ciNeedsYou({ status: "done", archivedAt: null, ci: ci("pending") })).toBe(false);
    expect(ciNeedsYou({ status: "done", archivedAt: null, ci: null })).toBe(false);
  });
});

describe("effectiveTrust", () => {
  const repo = (agentTrust: "locked" | "trusted" | "unrestricted") => ({
    agentTrust,
    trustProjectMcp: true,
    trustProjectHooks: true,
  });
  const pr = {
    kind: "github-pr",
    url: "https://github.com/a/b/pull/1",
    owner: "a",
    repo: "b",
    number: 1,
    connectionId: null,
  } as const;
  const free = { origin: { kind: "free-text" }, mode: null, prBranch: null } as const;

  it("runs a Locked repo's tasks Locked, never forced", () => {
    expect(effectiveTrust(repo("locked"), free)).toEqual(LOCKED_TRUST);
    expect(
      effectiveTrust(repo("locked"), { origin: pr, mode: "review", prBranch: "unchecked" }),
    ).toEqual(LOCKED_TRUST);
    expect(
      effectiveTrust(repo("locked"), { origin: pr, mode: "work", prBranch: "foreign" }),
    ).toEqual(LOCKED_TRUST);
  });

  it("forces Review PR tasks Locked", () => {
    for (const level of ["trusted", "unrestricted"] as const) {
      expect(
        effectiveTrust(repo(level), { origin: pr, mode: "review", prBranch: "owned" }),
      ).toEqual({
        ...LOCKED_TRUST,
        forced: true,
        forcedReason: "review",
      });
    }
  });

  it("forces work PR tasks Locked until their branch is known to be the user's", () => {
    expect(
      effectiveTrust(repo("trusted"), { origin: pr, mode: "work", prBranch: "unchecked" }),
    ).toMatchObject({ level: "locked", forced: true, forcedReason: "unchecked-branch" });
    expect(
      effectiveTrust(repo("unrestricted"), { origin: pr, mode: "work", prBranch: "foreign" }),
    ).toMatchObject({ level: "locked", forced: true, forcedReason: "foreign-branch" });
    expect(
      effectiveTrust(repo("trusted"), { origin: pr, mode: "work", prBranch: null }),
    ).toMatchObject({
      level: "locked",
      forcedReason: "unchecked-branch",
    });
  });

  it("runs an owned work PR at the repo's level", () => {
    expect(
      effectiveTrust(repo("trusted"), { origin: pr, mode: "work", prBranch: "owned" }),
    ).toEqual({
      level: "trusted",
      projectMcp: true,
      projectHooks: true,
      forced: false,
      forcedReason: null,
    });
  });

  it("runs other tasks at the repo's level, with the extras only under Trusted", () => {
    expect(effectiveTrust(repo("trusted"), free)).toMatchObject({
      level: "trusted",
      projectMcp: true,
    });
    expect(effectiveTrust({ ...repo("trusted"), trustProjectMcp: false }, free)).toMatchObject({
      projectMcp: false,
      projectHooks: true,
    });
    expect(effectiveTrust(repo("unrestricted"), free)).toEqual({
      level: "unrestricted",
      projectMcp: false,
      projectHooks: false,
      forced: false,
      forcedReason: null,
    });
  });
});

describe("taskSchema", () => {
  it("parses a task from JSON, reviving timestamps", () => {
    const parsed = taskSchema.parse(task);
    expect(parsed.createdAt).toEqual(new Date(now));
    expect(parsed.origin).toEqual({ kind: "jira-issue", key: "ABC-123", connectionId: "c1" });
  });

  it("parses a task's CI", () => {
    const ci = {
      state: "failed",
      sha: "abc1234def",
      host: "github.com",
      owner: "acme",
      repo: "web",
      checks: [
        {
          name: "test",
          kind: "check-run",
          id: 7,
          state: "failed",
          conclusion: "failure",
          url: "https://github.com/acme/web/runs/7",
        },
      ],
      hint: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: now,
    };
    expect(taskSchema.parse({ ...task, ci }).ci).toEqual(ci);
    expect(taskSchema.safeParse({ ...task, ci: { ...ci, state: "red" } }).success).toBe(false);
  });

  it("rejects unknown statuses and bad Jira keys", () => {
    expect(taskSchema.safeParse({ ...task, status: "pending" }).success).toBe(false);
    expect(
      taskSchema.safeParse({
        ...task,
        origin: { kind: "jira-issue", key: "abc", connectionId: null },
      }).success,
    ).toBe(false);
  });

  it("requires a mode for PR tasks only", () => {
    const pr = {
      kind: "github-pr",
      url: "https://github.com/acme/web/pull/42",
      owner: "acme",
      repo: "web",
      number: 42,
      connectionId: null,
    };
    expect(taskSchema.safeParse({ ...task, origin: pr, mode: "review" }).success).toBe(true);
    expect(taskSchema.safeParse({ ...task, origin: pr, mode: null }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, mode: "work" }).success).toBe(false);
  });

  it("parses a GitHub issue origin, without a mode", () => {
    const issue = {
      kind: "github-issue",
      url: "https://github.com/acme/web/issues/7",
      owner: "acme",
      repo: "web",
      number: 7,
      connectionId: "c2",
    };
    expect(taskSchema.parse({ ...task, origin: issue }).origin).toEqual(issue);
    expect(taskSchema.safeParse({ ...task, origin: issue, mode: "work" }).success).toBe(false);
  });
});

describe("githubPrOriginSchema", () => {
  const pr = {
    kind: "github-pr",
    url: "https://github.com/acme/web/pull/42",
    owner: "acme",
    repo: "web",
    number: 42,
    connectionId: null,
  };

  it("parses a PR origin with and without a stack", () => {
    expect(githubPrOriginSchema.parse(pr)).toEqual(pr);
    const stacked = { ...pr, stack: { prs: [41, 42, 43] } };
    expect(githubPrOriginSchema.parse(stacked)).toEqual(stacked);
  });

  it("rejects a stack of fewer than 2 PRs", () => {
    expect(githubPrOriginSchema.safeParse({ ...pr, stack: { prs: [42] } }).success).toBe(false);
    expect(githubPrOriginSchema.safeParse({ ...pr, stack: { prs: [] } }).success).toBe(false);
  });
});

describe("newTaskInputSchema", () => {
  it("fills defaults", () => {
    expect(
      newTaskInputSchema.parse({
        origin: { kind: "free-text" },
        repoId: "r1",
        freeText: "Add dark mode",
      }),
    ).toEqual({
      origin: { kind: "free-text" },
      mode: null,
      repoId: "r1",
      freeText: "Add dark mode",
      agents: {},
      agentClis: {},
      referenceRepoIds: null,
      triageMode: "intervene",
    });
  });

  it("takes reference repos, each once", () => {
    const base = { origin: { kind: "free-text" }, repoId: "r1", freeText: "x" };
    expect(newTaskInputSchema.parse({ ...base, referenceRepoIds: [] }).referenceRepoIds).toEqual(
      [],
    );
    expect(newTaskInputSchema.safeParse({ ...base, referenceRepoIds: ["r2", "r2"] }).success).toBe(
      false,
    );
  });

  it("requires a description for free-text tasks", () => {
    const result = newTaskInputSchema.safeParse({ origin: { kind: "free-text" }, repoId: "r1" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["freeText"]);
  });

  it("takes a start comment for GitHub issue tasks only", () => {
    const issue = {
      kind: "github-issue",
      url: "https://github.com/acme/web/issues/7",
      owner: "acme",
      repo: "web",
      number: 7,
      connectionId: null,
    };
    const startComment = { body: " Work has started. " };
    expect(
      newTaskInputSchema.parse({ origin: issue, repoId: "r1", startComment }).startComment,
    ).toEqual({ body: "Work has started." });
    const jira = newTaskInputSchema.safeParse({
      origin: { kind: "jira-issue", key: "ABC-1", connectionId: null },
      repoId: "r1",
      startComment,
    });
    expect(jira.success).toBe(false);
    expect(jira.error?.issues[0]?.path).toEqual(["startComment"]);
    expect(
      newTaskInputSchema.safeParse({ origin: issue, repoId: "r1", startComment: { body: " " } })
        .success,
    ).toBe(false);
  });

  it("assigns the issue to the user for GitHub issue tasks only", () => {
    const issue = {
      kind: "github-issue",
      url: "https://github.com/acme/web/issues/7",
      owner: "acme",
      repo: "web",
      number: 7,
      connectionId: null,
    };
    expect(
      newTaskInputSchema.parse({ origin: issue, repoId: "r1", assignToMe: true }).assignToMe,
    ).toBe(true);
    const freeText = newTaskInputSchema.safeParse({
      origin: { kind: "free-text" },
      freeText: "Fix it",
      repoId: "r1",
      assignToMe: true,
    });
    expect(freeText.success).toBe(false);
    expect(freeText.error?.issues[0]?.message).toBe("Only GitHub issue tasks can be assigned");
    expect(
      newTaskInputSchema.safeParse({
        origin: { kind: "free-text" },
        freeText: "Fix it",
        repoId: "r1",
        assignToMe: false,
      }).success,
    ).toBe(true);
  });
});

describe("repo backlog runner", () => {
  it("is not autonomous unless switched on", () => {
    expect(repoBacklogRunnerSchema.parse({}).autonomous).toBe(false);
    expect(repoBacklogRunnerSchema.parse({ autonomous: true }).autonomous).toBe(true);
  });

  it("takes an update that sets the switch, autonomy or both", () => {
    expect(repoBacklogRunnerUpdateSchema.parse({ autonomous: true })).toEqual({ autonomous: true });
    expect(repoBacklogRunnerUpdateSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(repoBacklogRunnerUpdateSchema.safeParse({}).success).toBe(false);
    expect(repoBacklogRunnerUpdateSchema.safeParse({ autonomous: "yes" }).success).toBe(false);
  });

  it("does not include remote issues unless switched on, and takes it as an update", () => {
    expect(repoBacklogRunnerSchema.parse({}).includeRemoteIssues).toBe(false);
    expect(repoBacklogRunnerUpdateSchema.parse({ includeRemoteIssues: true })).toEqual({
      includeRemoteIssues: true,
    });
  });
});

describe("backlog item inputs", () => {
  it("follow the repo's reference repos unless given, each once", () => {
    const base = { origin: { kind: "free-text" }, freeText: "x" };
    expect(newBacklogItemInputSchema.parse(base).referenceRepoIds).toBeNull();
    expect(newBacklogItemInputSchema.parse({ ...base, referenceRepoIds: ["r2"] })).toMatchObject({
      referenceRepoIds: ["r2"],
    });
    expect(
      newBacklogItemInputSchema.safeParse({ ...base, referenceRepoIds: ["r2", "r2"] }).success,
    ).toBe(false);

    expect(updateBacklogItemInputSchema.parse({})).not.toHaveProperty("referenceRepoIds");
    expect(updateBacklogItemInputSchema.parse({ referenceRepoIds: null }).referenceRepoIds).toBe(
      null,
    );
    expect(updateBacklogItemInputSchema.safeParse({ referenceRepoIds: ["r2", "r2"] }).success).toBe(
      false,
    );
  });
});

describe("findingSchema", () => {
  const finding = {
    id: "f1",
    taskId: "t1",
    runId: null,
    stepId: null,
    reviewerAgentId: "a2",
    severity: "high",
    tags: ["security"],
    file: "src/auth.ts",
    lineStart: 10,
    lineEnd: 12,
    title: "Token logged",
    explanation: "The token is written to stdout.",
    suggestedFix: null,
    status: "open",
    mergedIntoId: null,
    round: 0,
    createdAt: now,
    updatedAt: now,
  };

  it("accepts a valid finding and rejects an inverted line range", () => {
    expect(findingSchema.safeParse(finding).success).toBe(true);
    expect(findingSchema.safeParse({ ...finding, lineEnd: 9 }).success).toBe(false);
    expect(findingSchema.safeParse({ ...finding, severity: "blocker" }).success).toBe(false);
  });

  it("gates on critical and high only", () => {
    expect(["critical", "high", "medium", "low"].map((s) => isGatingSeverity(s as never))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("diff comments", () => {
  const comment = {
    file: "src/a.ts",
    lineStart: 3,
    lineEnd: 5,
    hunk: "@@ -3,2 +3,3 @@\n a\n+b\n c",
    body: "  Rename this.  ",
  };

  it("accepts a valid comment and trims its body", () => {
    expect(diffCommentInputSchema.parse(comment)).toEqual({ ...comment, body: "Rename this." });
  });

  it("rejects an empty or whitespace-only body", () => {
    expect(diffCommentInputSchema.safeParse({ ...comment, body: "" }).success).toBe(false);
    expect(diffCommentInputSchema.safeParse({ ...comment, body: "   " }).success).toBe(false);
  });

  it("rejects a line range that ends before it starts", () => {
    const result = diffCommentInputSchema.safeParse({ ...comment, lineStart: 5, lineEnd: 3 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["lineEnd"]);
  });

  it("accepts null lines", () => {
    expect(
      diffCommentInputSchema.parse({ ...comment, lineStart: null, lineEnd: null }),
    ).toMatchObject({ lineStart: null, lineEnd: null });
    expect(diffCommentInputSchema.safeParse({ ...comment, lineStart: null }).success).toBe(true);
  });

  it("requires at least one comment in a batch", () => {
    expect(diffCommentsInputSchema.safeParse({ comments: [] }).success).toBe(false);
    expect(diffCommentsInputSchema.safeParse({ comments: [comment] }).success).toBe(true);
  });
});

describe("isUserComment", () => {
  it("is true only when the finding has neither a step nor a reviewer", () => {
    expect(isUserComment({ stepId: null, reviewerAgentId: null })).toBe(true);
    expect(isUserComment({ stepId: "s1", reviewerAgentId: null })).toBe(false);
    expect(isUserComment({ stepId: null, reviewerAgentId: "a2" })).toBe(false);
    expect(isUserComment({ stepId: "s1", reviewerAgentId: "a2" })).toBe(false);
  });
});

describe("grillQuestionSchema", () => {
  it("carries needsHuman and who answered", () => {
    const q = grillQuestionSchema.parse({
      id: "q1",
      taskId: "t1",
      runId: null,
      stepId: null,
      askedByAgentId: "a2",
      question: "Keep the old endpoint?",
      needsHuman: true,
      answer: "Yes, for one release",
      answeredBy: "user",
      createdAt: now,
      answeredAt: now,
    });
    expect(q.needsHuman).toBe(true);
    expect(q.answeredAt).toBeInstanceOf(Date);
  });
});

describe("settings and inputs", () => {
  it("defaults settings", () => {
    expect(settingsSchema.parse({})).toEqual({
      roleDefaults: {},
      maxTasksPerRepo: 3,
      backlogRunner: true,
      maxBacklogTasksPerRepo: 1,
      stopBacklogOnNeedsYou: true,
      githubIssuesRefreshSeconds: 60,
      voiceModel: "moonshine-tiny-en",
      voiceHotkey: null,
    });
    expect(settingsSchema.safeParse({ maxTasksPerRepo: 0 }).success).toBe(false);
    expect(settingsSchema.safeParse({ githubIssuesRefreshSeconds: 14 }).success).toBe(false);
    expect(settingsSchema.safeParse({ githubIssuesRefreshSeconds: 3601 }).success).toBe(false);
  });

  it("takes a known voice model only", () => {
    expect(settingsSchema.parse({ voiceModel: "whisper-small" }).voiceModel).toBe("whisper-small");
    expect(settingsSchema.safeParse({ voiceModel: "whisper-huge" }).success).toBe(false);
    expect(generalSettingsUpdateSchema.parse({ voiceModel: "whisper-small" })).toEqual({
      voiceModel: "whisper-small",
    });
    expect(generalSettingsUpdateSchema.safeParse({ voiceModel: "nope" }).success).toBe(false);
  });

  const hotkey = (
    code: string,
    mods: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {},
  ) => ({
    code,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    ...mods,
  });
  const RESERVED = "That key is reserved by the browser or the app";

  it("takes a hold-to-talk key from the allow-list, with a modifier unless it is an F-key", () => {
    expect(voiceHotkeySchema.safeParse(hotkey("F9")).success).toBe(true);
    expect(voiceHotkeySchema.safeParse(hotkey("F24", { shift: true })).success).toBe(true);
    expect(voiceHotkeySchema.safeParse(hotkey("KeyP", { ctrl: true, alt: true })).success).toBe(
      true,
    );
    expect(voiceHotkeySchema.safeParse(hotkey("Digit5", { alt: true })).success).toBe(true);
    expect(voiceHotkeySchema.safeParse(hotkey("F25")).success).toBe(false);
    expect(voiceHotkeySchema.safeParse(hotkey("Escape", { ctrl: true })).success).toBe(false);
    expect(voiceHotkeySchema.safeParse(hotkey("Slash", { ctrl: true })).success).toBe(false);
    for (const bare of [hotkey("KeyP"), hotkey("Space"), hotkey("KeyP", { shift: true })]) {
      const parsed = voiceHotkeySchema.safeParse(bare);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe(
        "Add Ctrl, Alt or ⌘ to letters, digits and Space",
      );
    }
    expect(settingsSchema.parse({}).voiceHotkey).toBeNull();
    expect(settingsSchema.parse({ voiceHotkey: hotkey("F9") }).voiceHotkey).toEqual(hotkey("F9"));
    expect(generalSettingsUpdateSchema.parse({ voiceHotkey: null })).toEqual({ voiceHotkey: null });
    expect(generalSettingsUpdateSchema.safeParse({ voiceHotkey: hotkey("KeyP") }).success).toBe(
      false,
    );
  });

  it("rejects reserved hold-to-talk chords", () => {
    for (const chord of [
      hotkey("KeyW", { ctrl: true }),
      hotkey("KeyQ", { meta: true }),
      hotkey("KeyR", { ctrl: true, shift: true }),
      hotkey("KeyI", { ctrl: true, shift: true }),
      hotkey("KeyI", { alt: true, meta: true }),
      hotkey("KeyC", { ctrl: true }),
      hotkey("KeyS", { ctrl: true }),
      hotkey("KeyS", { meta: true }),
      hotkey("KeyS", { ctrl: true, shift: true }),
      hotkey("KeyK", { ctrl: true }),
      hotkey("F11"),
      hotkey("F12"),
      hotkey("F4", { alt: true }),
    ]) {
      const parsed = voiceHotkeySchema.safeParse(chord);
      expect(parsed.success, JSON.stringify(chord)).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([RESERVED]);
    }
    for (const chord of [
      hotkey("KeyW", { ctrl: true, alt: true }),
      hotkey("KeyS", { ctrl: true, alt: true }),
      hotkey("KeyK", { ctrl: true, alt: true }),
      hotkey("Space", { ctrl: true, alt: true }),
      hotkey("F9"),
      hotkey("Space", { ctrl: true, shift: true }),
    ]) {
      expect(voiceHotkeySchema.safeParse(chord).success, JSON.stringify(chord)).toBe(true);
    }
  });

  it("labels a hold-to-talk key", () => {
    expect(voiceHotkeyLabel(hotkey("Space", { ctrl: true, alt: true }), false)).toBe(
      "Ctrl Alt Space",
    );
    expect(voiceHotkeyLabel(hotkey("Space", { alt: true, meta: true }), true)).toBe("⌥⌘Space");
    expect(voiceHotkeyLabel(hotkey("KeyP", { ctrl: true, shift: true }), false)).toBe(
      "Ctrl Shift P",
    );
    expect(voiceHotkeyLabel(hotkey("Digit1", { meta: true }), false)).toBe("Meta 1");
    expect(voiceHotkeyLabel(hotkey("F9"), true)).toBe("F9");
  });

  it("lists every file a voice model's kind needs", () => {
    expect(VOICE_MODEL_IDS).toContain("moonshine-tiny-en");
    for (const id of VOICE_MODEL_IDS) {
      const model = VOICE_MODELS[id];
      expect(Object.keys(model.files).sort()).toEqual([...VOICE_MODEL_FILES[model.kind]].sort());
      for (const file of Object.values(model.files)) expect(file).toMatch(/\S/);
      expect(model.archive).toMatch(/^sherpa-onnx-/);
    }
  });

  it("downloads a known voice model only", () => {
    expect(voiceDownloadInputSchema.parse({ model: "whisper-small" })).toEqual({
      model: "whisper-small",
    });
    expect(voiceDownloadInputSchema.safeParse({ model: "whisper-huge" }).success).toBe(false);
    expect(voiceDownloadInputSchema.safeParse({}).success).toBe(false);
  });

  it("trims and caps a voice command", () => {
    expect(voiceCommandInputSchema.parse({ repoId: "r1", text: "  confirm " })).toEqual({
      repoId: "r1",
      text: "confirm",
    });
    expect(voiceCommandInputSchema.safeParse({ repoId: "r1", text: "   " }).success).toBe(false);
    expect(voiceCommandInputSchema.safeParse({ repoId: "", text: "hi" }).success).toBe(false);
    const long = "x".repeat(MAX_VOICE_COMMAND_CHARS + 1);
    expect(voiceCommandInputSchema.safeParse({ repoId: "r1", text: long }).success).toBe(false);
  });

  it("takes the sending client and its open task with a voice command", () => {
    expect(
      voiceCommandInputSchema.parse({ repoId: "r1", text: "hi", clientId: "c1", taskId: "t1" }),
    ).toEqual({ repoId: "r1", text: "hi", clientId: "c1", taskId: "t1" });
    const post = (extra: object) =>
      voiceCommandInputSchema.safeParse({ repoId: "r1", text: "hi", ...extra }).success;
    expect(post({ clientId: "" })).toBe(false);
    expect(post({ clientId: "c".repeat(101) })).toBe(false);
    expect(post({ taskId: "" })).toBe(false);
  });

  it("parses the voice state's client and UI actions, and refuses an unknown action", () => {
    const state = {
      busy: false,
      repoId: "r1",
      transcript: "go home",
      activity: null,
      reply: null,
      error: null,
      draft: null,
      created: null,
      clientId: "c1",
      actions: [
        { id: "a1", kind: "show-grid" },
        { id: "a2", kind: "select-repo", repoId: "r2" },
        { id: "a3", kind: "open-chat" },
        { id: "a4", kind: "open-task", taskId: "t1" },
      ],
    };
    expect(voiceStateSchema.parse(state)).toEqual(state);
    expect(
      voiceStateSchema.safeParse({ ...state, actions: [{ id: "a5", kind: "explode" }] }).success,
    ).toBe(false);
    expect(
      voiceStateSchema.safeParse({ ...state, actions: [{ id: "a6", kind: "select-repo" }] })
        .success,
    ).toBe(false);
  });

  it("leaves repo check commands unset so they can be suggested", () => {
    expect(repoInputSchema.parse({ path: " /code/app " })).toEqual({ path: "/code/app" });
    expect(repoInputSchema.parse({ path: "/code/app", checkCommands: [] }).checkCommands).toEqual(
      [],
    );
  });

  it("accepts repo setup commands and rejects blank ones", () => {
    expect(repoInputSchema.parse({ path: "/code/app", setupCommands: [" npm ci "] })).toEqual({
      path: "/code/app",
      setupCommands: ["npm ci"],
    });
    expect(repoUpdateSchema.parse({ setupCommands: [] })).toEqual({ setupCommands: [] });
    expect(repoUpdateSchema.safeParse({ setupCommands: ["  "] }).success).toBe(false);
    expect(repoInputSchema.safeParse({ path: "/code/app", setupCommands: [""] }).success).toBe(
      false,
    );
  });

  it("accepts a repo's default CLI and rejects unknown ones", () => {
    expect(repoUpdateSchema.parse({ defaultCli: "copilot" })).toEqual({ defaultCli: "copilot" });
    expect(repoUpdateSchema.safeParse({ defaultCli: "codex" }).success).toBe(false);
  });

  it("accepts a repo's reference repos once each", () => {
    expect(repoUpdateSchema.parse({ referenceRepoIds: ["a", "b"] })).toEqual({
      referenceRepoIds: ["a", "b"],
    });
    expect(repoUpdateSchema.parse({ referenceRepoIds: [] })).toEqual({ referenceRepoIds: [] });
    expect(repoUpdateSchema.safeParse({ referenceRepoIds: ["a", "a"] }).success).toBe(false);
    expect(repoUpdateSchema.safeParse({ referenceRepoIds: [""] }).success).toBe(false);
  });

  it("accepts a repo's default origin and rejects unknown ones", () => {
    expect(repoUpdateSchema.parse({ defaultOrigin: "github-pr" })).toEqual({
      defaultOrigin: "github-pr",
    });
    expect(repoUpdateSchema.safeParse({ defaultOrigin: "email" }).success).toBe(false);
  });

  it("accepts a repo's backlog cap, or null to clear it, and rejects others", () => {
    expect(repoUpdateSchema.parse({ maxBacklogTasks: 3 })).toEqual({ maxBacklogTasks: 3 });
    expect(repoUpdateSchema.parse({ maxBacklogTasks: null })).toEqual({ maxBacklogTasks: null });
    for (const maxBacklogTasks of [0, 21, 1.5]) {
      expect(repoUpdateSchema.safeParse({ maxBacklogTasks }).success).toBe(false);
    }
  });

  it("accepts a repo's Jira project key, or null to clear it, and rejects others", () => {
    for (const jiraProject of ["ABC", "A1_B", null]) {
      expect(repoUpdateSchema.parse({ jiraProject })).toEqual({ jiraProject });
    }
    for (const jiraProject of ["abc", "1AB", "AB-1"]) {
      expect(repoUpdateSchema.safeParse({ jiraProject }).success).toBe(false);
    }
  });

  it("accepts a repo's default branch and rejects names git would misread", () => {
    expect(repoUpdateSchema.parse({ defaultBranch: "develop" })).toEqual({
      defaultBranch: "develop",
    });
    expect(repoUpdateSchema.parse({ defaultBranch: " release/2026 " })).toEqual({
      defaultBranch: "release/2026",
    });
    for (const defaultBranch of [
      "",
      "  ",
      "-x",
      "/x",
      "x/",
      "a..b",
      "has space",
      "a:b",
      "a~1",
      "a^",
      "a?",
      "a*",
      "a[b",
      "a\\b",
      "x.lock",
      "refs/heads/main",
    ]) {
      expect(repoUpdateSchema.safeParse({ defaultBranch }).success).toBe(false);
    }
  });

  it("uses a repo's own backlog cap over the global one", () => {
    const general = { maxBacklogTasksPerRepo: 2 };
    expect(backlogCapFor({ maxBacklogTasks: 5 }, general)).toBe(5);
    expect(backlogCapFor({ maxBacklogTasks: null }, general)).toBe(2);
    expect(backlogCapFor(undefined, general)).toBe(2);
  });

  it("accepts a repo's favourite flag", () => {
    expect(repoUpdateSchema.parse({ favorite: true })).toEqual({ favorite: true });
    expect(repoUpdateSchema.parse({ watchCi: false })).toEqual({ watchCi: false });
    expect(repoUpdateSchema.parse({ agentTrust: "trusted", trustProjectMcp: true })).toEqual({
      agentTrust: "trusted",
      trustProjectMcp: true,
    });
    expect(repoUpdateSchema.safeParse({ agentTrust: "yolo" }).success).toBe(false);
    expect(repoUpdateSchema.safeParse({ favorite: "yes" }).success).toBe(false);
  });

  it("rejects a repo order that lists a repo twice", () => {
    expect(reorderReposInputSchema.safeParse({ ids: ["a", "b"] }).success).toBe(true);
    expect(reorderReposInputSchema.safeParse({ ids: ["a", "a"] }).success).toBe(false);
  });

  it("defaults the repo scan depth", () => {
    expect(repoScanInputSchema.parse({ root: "/code" })).toEqual({ root: "/code", maxDepth: 3 });
    expect(repoScanInputSchema.safeParse({ root: "/code", maxDepth: 99 }).success).toBe(false);
  });
});

describe("connectionViewSchema", () => {
  const view = {
    id: "c1",
    name: "acme.ghe.com",
    kind: "github",
    baseUrl: "https://acme.ghe.com",
    authMeta: {},
    hasToken: true,
    createdAt: now,
    updatedAt: now,
  };

  it("exposes hasToken and rejects any extra field", () => {
    expect(connectionViewSchema.parse(view).hasToken).toBe(true);
    expect(connectionViewSchema.safeParse({ ...view, token: "secret" }).success).toBe(false);
    expect(connectionViewSchema.safeParse({ ...view, tokenSet: true }).success).toBe(false);
  });
});

describe("reviewRequestsSchema", () => {
  const pr = {
    host: "acme.ghe.com",
    owner: "acme",
    repo: "shop",
    number: 42,
    title: "Round invoice totals once",
    url: "https://acme.ghe.com/acme/shop/pull/42",
    author: null,
    updatedAt: now,
    reviewDecision: null,
    repoId: null,
    connectionId: null,
  };

  it("coerces dates and allows a null author and decision", () => {
    const parsed = reviewRequestsSchema.parse({
      pullRequests: [pr, { ...pr, author: "kari", reviewDecision: "changes-requested" }],
      errors: [{ host: "github.com", message: "github.com: token rejected" }],
    });
    expect(parsed.pullRequests[0]!.updatedAt).toEqual(new Date(now));
    expect(parsed.pullRequests[0]!.reviewDecision).toBeNull();
    expect(parsed.pullRequests[1]!.reviewDecision).toBe("changes-requested");
    expect(parsed.errors).toHaveLength(1);
  });

  it("keeps the registered repo and the host's connection", () => {
    const parsed = reviewRequestsSchema.parse({
      pullRequests: [{ ...pr, repoId: "r1", connectionId: "c2" }],
      errors: [],
    });
    expect(parsed.pullRequests[0]!.repoId).toBe("r1");
    expect(parsed.pullRequests[0]!.connectionId).toBe("c2");
  });

  it("rejects an unknown decision", () => {
    const parsed = reviewRequestsSchema.safeParse({
      pullRequests: [{ ...pr, reviewDecision: "APPROVED" }],
      errors: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("assignedIssuesSchema", () => {
  const issue = {
    host: "acme.ghe.com",
    owner: "acme",
    repo: "shop",
    number: 7,
    title: "Totals drift by a cent",
    url: "https://acme.ghe.com/acme/shop/issues/7",
    author: null,
    updatedAt: now,
    repoId: "r1",
    connectionId: "c1",
  };

  it("coerces dates, allows a null author and keeps errors", () => {
    const parsed = assignedIssuesSchema.parse({
      issues: [issue, { ...issue, number: 8, author: "kari" }],
      errors: [{ host: "github.com", message: "github.com: token rejected" }],
    });
    expect(parsed.issues[0]!.updatedAt).toEqual(new Date(now));
    expect(parsed.issues[0]!.author).toBeNull();
    expect(parsed.issues[1]!.author).toBe("kari");
    expect(parsed.errors).toEqual([{ host: "github.com", message: "github.com: token rejected" }]);
    expect(parsed.issues[0]!.repoId).toBe("r1");
    expect(parsed.issues[0]!.connectionId).toBe("c1");
  });

  it("allows an unregistered repo and no connection", () => {
    const parsed = assignedIssuesSchema.parse({
      issues: [{ ...issue, repoId: null, connectionId: null }],
      errors: [],
    });
    expect(parsed.issues[0]!.repoId).toBeNull();
    expect(parsed.issues[0]!.connectionId).toBeNull();
  });
});

describe("repoIssuesSchema", () => {
  it("parses a repo's issues with their assignees", () => {
    const parsed = repoIssuesSchema.parse({
      issues: [
        {
          host: "github.com",
          owner: "acme",
          repo: "shop",
          number: 7,
          title: "Totals drift by a cent",
          url: "https://github.com/acme/shop/issues/7",
          author: "kari",
          updatedAt: now,
          repoId: "r1",
          connectionId: "c1",
          assignees: ["ola"],
        },
      ],
      errors: [],
    });
    expect(parsed.issues[0]!.assignees).toEqual(["ola"]);
    expect(parsed.issues[0]!.updatedAt).toEqual(new Date(now));
    expect(repoIssuesSchema.safeParse({ issues: [{}], errors: [] }).success).toBe(false);
  });
});

describe("connectionInputSchema", () => {
  const github = { name: "github.com", kind: "github", baseUrl: "https://github.com" };

  it("defaults authMeta and accepts an optional token", () => {
    expect(connectionInputSchema.parse(github)).toEqual({ ...github, authMeta: {} });
    expect(connectionInputSchema.parse({ ...github, token: " t " }).token).toBe("t");
    expect(connectionInputSchema.safeParse({ ...github, token: " " }).success).toBe(false);
  });

  it("requires the account email for Jira", () => {
    const jira = { name: "acme", kind: "jira", baseUrl: "https://acme.atlassian.net" };
    expect(connectionInputSchema.safeParse(jira).success).toBe(false);
    expect(
      connectionInputSchema.safeParse({ ...jira, authMeta: { email: "not-an-email" } }).success,
    ).toBe(false);
    expect(
      connectionInputSchema.safeParse({ ...jira, authMeta: { email: "me@acme.test" } }).success,
    ).toBe(true);
  });
});

describe("agents", () => {
  it("only lets the Implement stage edit", () => {
    expect(stagePermissionProfile("implement")).toBe("implement");
    for (const stage of ["inform", "plan-review", "code-review", "summarize"] as const) {
      expect(stagePermissionProfile(stage)).toBe("read-only");
    }
    expect(stagePermissionProfile(ROLE_STAGES.codeReviewers)).toBe("read-only");
  });

  it("accepts partial agent updates and rejects blank permission rules", () => {
    expect(agentUpdateSchema.parse({ models: { copilot: "gpt-5" } })).toEqual({
      models: { copilot: "gpt-5" },
    });
    expect(
      agentUpdateSchema.safeParse({ permissionOverrides: { claude: { allow: [" "] } } }).success,
    ).toBe(false);
    expect(agentUpdateSchema.safeParse({ models: { codex: "o3" } }).success).toBe(false);
    expect(
      agentUpdateSchema.parse({ models: { opencode: "anthropic/claude-sonnet-5-5" } }),
    ).toEqual({ models: { opencode: "anthropic/claude-sonnet-5-5" } });
  });

  it("accepts each CLI's own effort levels and rejects others", () => {
    expect(agentUpdateSchema.parse({ efforts: { claude: " low " } })).toEqual({
      efforts: { claude: "low" },
    });
    expect(agentUpdateSchema.parse({ efforts: { copilot: "xhigh" } })).toEqual({
      efforts: { copilot: "xhigh" },
    });
    const turbo = agentUpdateSchema.safeParse({ efforts: { claude: "turbo" } });
    expect(turbo.success).toBe(false);
    expect(turbo.error?.issues[0]?.message).toMatch(/Allowed: low, medium, high, xhigh, max/);
    // OpenCode has no effort setting, so no level is valid for it.
    expect(AGENT_EFFORT_LEVELS.opencode).toEqual([]);
    expect(agentUpdateSchema.safeParse({ efforts: { opencode: "low" } }).success).toBe(false);
    expect(agentInputSchema.parse({ name: "A" }).efforts).toEqual({});
  });

  it("rejects an effort for a model its CLI takes none for", () => {
    expect(effortFlagApplies("copilot", "auto")).toBe(false);
    expect(effortFlagApplies("copilot", "claude-haiku-5.5")).toBe(true);
    expect(effortFlagApplies("copilot", null)).toBe(true);
    expect(effortFlagApplies("claude", "auto")).toBe(true);
    const pair = { models: { copilot: "auto" }, efforts: { copilot: "low" } };
    expect(agentUpdateSchema.safeParse(pair).success).toBe(false);
    expect(agentInputSchema.safeParse({ name: "A", ...pair }).success).toBe(false);
    expect(agentUpdateSchema.safeParse({ ...pair, efforts: {} }).success).toBe(true);
  });

  it("checks OpenCode permission rules against OpenCode's grammar", () => {
    const opencode = (rules: string[]) =>
      agentPermissionOverridesSchema.safeParse({ opencode: { allow: rules, deny: rules } });
    expect(
      opencode(["bash(npm test*)", "bash", "webfetch", "read", "task(blackwall-worker)"]).success,
    ).toBe(true);
    for (const rule of ["Bash(npm test:*)", "shell(npm test)", "foo", "bash()", "Task(x)"]) {
      const result = opencode([rule]);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toMatch(
        /bash\(<glob>\) or task\(<agent>\), e\.g\. bash\(npm test\*\)/,
      );
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([
        ["opencode", "allow", 0],
        ["opencode", "deny", 0],
      ]);
    }
  });

  it("leaves Claude and Copilot rules free-form", () => {
    expect(
      agentPermissionOverridesSchema.safeParse({
        claude: { allow: ["Bash(npm test:*)", "anything"] },
        copilot: { deny: ["shell(npm test)", "foo"] },
      }).success,
    ).toBe(true);
  });

  it("runs an agent on the task's CLI unless the task overrides it", () => {
    const parsed = taskSchema.parse(task);
    expect(agentCliFor(parsed, "a1")).toBe("copilot");
    expect(agentCliFor(parsed, "a2")).toBe("claude");
  });
});

describe("reviewOutputSchema", () => {
  const finding = {
    severity: "high",
    tags: ["security"],
    file: "src/a.ts",
    lineStart: 3,
    lineEnd: 4,
    title: "SQL built from input",
    explanation: "User input reaches the query unescaped.",
    suggestedFix: null,
  };

  it("parses a reviewer's findings and rejects unknown fields", () => {
    expect(reviewOutputSchema.parse({ findings: [finding] }).findings).toHaveLength(1);
    expect(reviewOutputSchema.safeParse({ findings: [{ ...finding, id: "x" }] }).success).toBe(
      false,
    );
    expect(
      reviewOutputSchema.safeParse({ findings: [{ ...finding, severity: "blocker" }] }).success,
    ).toBe(false);
  });

  it("exports a JSON Schema for structured output", () => {
    const schema = reviewOutputJsonSchema();
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["findings"]);
  });
});

describe("plan review output", () => {
  it("parses a reviewer's questions and rejects unknown fields", () => {
    const output = { questions: [{ question: "Which locale?", needsHuman: true }] };
    expect(planReviewOutputSchema.parse(output)).toEqual(output);
    expect(planReviewOutputSchema.parse({ questions: [] }).questions).toEqual([]);
    expect(
      planReviewOutputSchema.safeParse({ questions: [{ question: "Why?", needsHuman: "no" }] })
        .success,
    ).toBe(false);
    expect(planReviewOutputSchema.safeParse({ questions: [{ question: " " }] }).success).toBe(
      false,
    );
    expect(planReviewOutputJsonSchema().required).toEqual(["questions"]);
  });

  it("parses the planner's answers, null when the user must decide", () => {
    const output = {
      answers: [
        { question: 1, answer: "Use the existing helper" },
        { question: 2, answer: null },
      ],
      plan: "1. Reuse the helper",
    };
    expect(planAnswersOutputSchema.parse(output)).toEqual(output);
    expect(planAnswersOutputSchema.safeParse({ ...output, plan: "" }).success).toBe(false);
    expect(
      planAnswersOutputSchema.safeParse({ answers: [{ question: 0, answer: "x" }], plan: "p" })
        .success,
    ).toBe(false);
    expect(planAnswersOutputJsonSchema().required).toEqual(["answers", "plan"]);
  });
});

describe("delivery", () => {
  it("confirms nothing unless actions are listed, each at most once", () => {
    expect(deliveryConfirmationSchema.parse({})).toEqual({
      actions: [],
      squash: false,
      findingIds: [],
      followUpIndexes: [],
      approve: false,
    });
    expect(deliveryConfirmationSchema.parse({ approve: true }).approve).toBe(true);
    expect(
      deliveryConfirmationSchema.safeParse({ actions: ["push-branch", "push-branch"] }).success,
    ).toBe(false);
    expect(deliveryConfirmationSchema.safeParse({ followUpIndexes: [1, 1] }).success).toBe(false);
    expect(deliveryConfirmationSchema.safeParse({ followUpIndexes: [-1] }).success).toBe(false);
    expect(deliveryConfirmationSchema.safeParse({ actions: ["push-main"] }).success).toBe(false);
    const gate = gateResponseInputSchema.parse({
      gate: "finish",
      decision: "approve",
      delivery: { actions: ["merge-main"], squash: true },
    });
    expect(gate.delivery).toEqual({
      actions: ["merge-main"],
      squash: true,
      findingIds: [],
      followUpIndexes: [],
      approve: false,
    });
  });

  it("parses a create-tasks action", () => {
    const action = {
      kind: "create-tasks",
      items: [{ title: "Add tests", description: "Cover login", repoId: "r1", repoName: "app" }],
    };
    expect(deliveryActionSchema.parse(action)).toEqual(action);
  });

  it("parses an issue comment action and a plan approval's issue comment", () => {
    const action = { kind: "issue-comment", url: "https://github.com/a/b/issues/7", body: "Done" };
    expect(deliveryActionSchema.parse(action)).toEqual(action);
    expect(deliveryConfirmationSchema.parse({ actions: ["issue-comment"] }).actions).toEqual([
      "issue-comment",
    ]);
    expect(
      gateResponseInputSchema.parse({
        gate: "plan-approval",
        decision: "approve",
        issueComment: { body: "Plan approved." },
      }).issueComment,
    ).toEqual({ body: "Plan approved." });
    expect(
      gateResponseInputSchema.safeParse({
        gate: "plan-approval",
        decision: "approve",
        issueComment: { body: "" },
      }).success,
    ).toBe(false);
  });

  it("validates the summarizer's output", () => {
    const output = { summary: "Did it", commitMessage: "Do it", shortSummary: "It works" };
    expect(summaryOutputSchema.parse(output)).toEqual(output);
    expect(summaryOutputSchema.safeParse({ summary: "Did it" }).success).toBe(false);
    expect(summaryOutputJsonSchema().required).toEqual([
      "summary",
      "commitMessage",
      "shortSummary",
    ]);
  });

  it("takes optional follow-ups in the summarizer's output", () => {
    const followUps = [{ title: "Add tests", description: "Cover login", repoId: null }];
    const output = {
      summary: "Did it",
      commitMessage: "Do it",
      shortSummary: "It works",
      followUps,
    };
    expect(summaryOutputSchema.parse(output)).toEqual(output);
    expect(summaryOutputSchema.safeParse({ ...output, followUps: "oops" }).success).toBe(false);
    expect(summaryOutputSchema.safeParse({ ...output, extra: 1 }).success).toBe(false);
  });

  it("puts no caps or dependencies on follow-ups in the JSON Schema", () => {
    const json = summaryOutputJsonSchema() as {
      properties: { followUps: { maxItems?: number; items: Record<string, unknown> } };
    };
    const followUps = json.properties.followUps;
    expect(followUps.maxItems).toBeUndefined();
    const text = JSON.stringify(followUps);
    expect(text).not.toMatch(/minLength|maxLength|maxItems|dependsOn/);
    expect(followUps.items).toMatchObject({ required: ["title", "description", "repoId"] });
  });

  it("keeps the summary when the follow-ups are invalid", () => {
    const output = { summary: "Did it", commitMessage: "Do it", followUps: "oops" };
    expect(summaryCoreSchema.parse(output)).toEqual({ summary: "Did it", commitMessage: "Do it" });
  });

  it("parses the short summary apart, so a missing one keeps the summary", () => {
    expect(shortSummarySchema.safeParse({ shortSummary: "  " }).success).toBe(false);
    expect(shortSummarySchema.parse({ shortSummary: " It works " })).toEqual({
      shortSummary: "It works",
    });
    const output = { summary: "Did it", commitMessage: "Do it" };
    expect(summaryCoreSchema.parse(output)).toEqual(output);
  });
});

describe("parseFollowUps", () => {
  const valid = (n: number) => ({ title: `Task ${n}`, description: "Do it", repoId: null });

  it("gives none for anything but an array", () => {
    expect(parseFollowUps(undefined)).toEqual([]);
    expect(parseFollowUps("oops")).toEqual([]);
    expect(parseFollowUps({ title: "x" })).toEqual([]);
  });

  it("drops invalid entries, trims, strips unknown keys and keeps at most five", () => {
    const parsed = parseFollowUps([
      { title: "  Add tests  ", description: " Cover login ", repoId: " r2 ", dependsOn: [0] },
      { title: "", description: "No title", repoId: null },
      { title: "No description", description: "  ", repoId: null },
      { title: "x".repeat(121), description: "Too long", repoId: null },
      "oops",
      ...[1, 2, 3, 4, 5].map(valid),
    ]);
    expect(parsed).toHaveLength(MAX_FOLLOW_UPS);
    expect(parsed[0]).toEqual({ title: "Add tests", description: "Cover login", repoId: "r2" });
    expect(parsed.slice(1).map((f) => f.title)).toEqual(["Task 1", "Task 2", "Task 3", "Task 4"]);
  });
});

describe("chat schemas", () => {
  it("accepts every action kind in a reply and rejects an overlong title", () => {
    const actions = [
      { kind: "create-task", title: "Add tests", description: "Cover the parser" },
      { kind: "message-task", taskId: "t1", message: "Keep the API stable" },
      { kind: "answer-question", taskId: "t1", questionId: "q1", answer: "Zip" },
      { kind: "stop-task", taskId: "t1" },
      { kind: "resume-task", taskId: "t2" },
      { kind: "resume-task", taskId: "t2", message: "Use the v2 client" },
    ];
    expect(chatReplySchema.parse({ reply: "Done", actions }).actions).toEqual(actions);
    const overlong = { kind: "create-task", title: "x".repeat(121), description: "d" };
    expect(chatReplySchema.safeParse({ reply: "", actions: [overlong] }).success).toBe(false);
    expect(JSON.stringify(chatReplyJsonSchema())).toContain('"anyOf"');
  });

  it("rejects extra keys and blank answers or guidance on actions", () => {
    const parses = (action: unknown) => chatActionProposalSchema.safeParse(action).success;
    const answer = { kind: "answer-question", taskId: "t1", questionId: "q1", answer: "Zip" };
    expect(parses({ ...answer, answer: "  " })).toBe(false);
    expect(parses({ ...answer, questionId: undefined })).toBe(false);
    expect(parses({ ...answer, note: "x" })).toBe(false);
    expect(parses({ kind: "resume-task", taskId: "t1", message: " " })).toBe(false);
    expect(parses({ kind: "resume-task", taskId: "t1", note: "x" })).toBe(false);
  });

  it("takes only the text with a chat message; the URL names the task", () => {
    expect(chatSendInputSchema.parse({ text: " Why? " })).toEqual({ text: "Why?" });
    expect(chatSendInputSchema.parse({ text: "Why?", taskId: "t1" })).toEqual({ text: "Why?" });
  });

  it("requires a chat state's task id, null for the repo's chat", () => {
    const repoChat = { repoId: "r1", taskId: null, busy: false, activity: null, messages: [] };
    expect(chatStateSchema.parse(repoChat)).toEqual(repoChat);
    expect(chatStateSchema.parse({ ...repoChat, taskId: "t1" }).taskId).toBe("t1");
    expect(chatStateSchema.safeParse({ ...repoChat, taskId: undefined }).success).toBe(false);
  });

  it("takes optional guidance when resuming a task", () => {
    expect(taskResumeInputSchema.parse({})).toEqual({});
    expect(taskResumeInputSchema.parse({ message: " Retry " })).toEqual({ message: "Retry" });
    expect(taskResumeInputSchema.safeParse({ message: "" }).success).toBe(false);
  });

  it("accepts a stored action with its id and applied time", () => {
    const state = {
      repoId: "r1",
      taskId: null,
      busy: false,
      activity: null,
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "Ok",
          createdAt: "2026-10-14T10:00:00.000Z",
          actions: [{ kind: "stop-task", taskId: "t1", id: "a1", appliedAt: null }],
        },
      ],
    };
    expect(chatStateSchema.parse(state)).toEqual(state);
    const noId = structuredClone(state);
    delete (noId.messages[0]!.actions[0] as { id?: string }).id;
    expect(chatStateSchema.safeParse(noId).success).toBe(false);
  });
});

describe("search schemas", () => {
  it("trims the query and defaults the scope to all", () => {
    expect(searchQuerySchema.parse({ q: "  login " })).toEqual({ q: "login", scope: "all" });
    expect(searchQuerySchema.safeParse({ q: "x", scope: "elsewhere" }).success).toBe(false);
  });

  it("parses grouped results", () => {
    const results = {
      tasks: [
        {
          id: "t1",
          title: "Fix login",
          repoId: "r1",
          repoName: "app",
          status: "done",
          archived: true,
          origin: { kind: "free-text" },
          snippet: "…the login form…",
        },
      ],
      backlogItems: [
        {
          id: "b1",
          title: "Login tests",
          repoId: "r1",
          repoName: "app",
          status: "paused",
          origin: { kind: "free-text" },
          snippet: null,
        },
      ],
      repos: [{ id: "r1", name: "app", path: "/code/app" }],
    };
    expect(searchResultsSchema.parse(results)).toEqual(results);
    const promoted = structuredClone(results);
    (promoted.backlogItems[0] as { status: string }).status = "promoted";
    expect(searchResultsSchema.safeParse(promoted).success).toBe(false);
  });
});

describe("stepSchema", () => {
  const step = {
    id: "s1",
    runId: "r1",
    stage: "implement",
    agentId: "a1",
    cli: "copilot",
    trust: "trusted",
    trustForced: false,
    effort: null,
    round: 0,
    visit: 0,
    status: "succeeded",
    sessionId: null,
    error: null,
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
  };

  it("parses a step with its usage", () => {
    expect(stepSchema.parse(step)).toMatchObject({ inputTokens: 10, costUsd: null });
  });

  it("rejects a negative token count", () => {
    expect(stepSchema.safeParse({ ...step, outputTokens: -1 }).success).toBe(false);
  });

  it("records the effort the step ran at, or null", () => {
    expect(stepSchema.parse(step).effort).toBeNull();
    expect(stepSchema.parse({ ...step, effort: "low" }).effort).toBe("low");
  });
});
