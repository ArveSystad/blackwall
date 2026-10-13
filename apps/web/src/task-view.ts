import {
  agentCliFor,
  isGatingSeverity,
  JIRA_KEY_PATTERN,
  TASK_STOPPED_ERROR,
  type ConnectionView,
  type Agent,
  type AgentCli,
  type AgentClis,
  type DeliveryAction,
  type Finding,
  type Gate,
  type GrillQuestion,
  type RoleAgents,
  type Severity,
  type Stage,
  type Step,
  type StepEvent,
  type Task,
} from "@blackwall/shared";
import { uiStageIndex } from "./inbox";

// ---------------------------------------------------------------------------
// Tabs and the needs-you banner
// ---------------------------------------------------------------------------

export const TASK_TABS = [
  "context",
  "plan",
  "grill",
  "output",
  "findings",
  "diff",
  "artifacts",
  "checks",
  "finish",
] as const;
export type TaskTab = (typeof TASK_TABS)[number];

export const TAB_LABELS: Record<TaskTab, string> = {
  context: "Context",
  plan: "Plan",
  grill: "Grill",
  output: "Agent output",
  findings: "Findings",
  diff: "Diff",
  artifacts: "Artifacts",
  checks: "Checks",
  finish: "Finish",
};

/** Review PR tasks deliver at the triage gate: the review is posted from the Finish tab. */
export function isReviewTriage(task: Pick<Task, "mode" | "gate">): boolean {
  return task.mode === "review" && task.gate === "triage";
}

/** Whether the Finish tab (summary and outbound actions) applies yet. */
export function hasFinish(task: Pick<Task, "mode" | "gate" | "status" | "summary">): boolean {
  return (
    task.gate === "finish" ||
    isReviewTriage(task) ||
    task.status === "done" ||
    task.summary !== null
  );
}

/** Tabs that have nothing to show before the task reaches their stage. */
export function isTabEnabled(task: Task, tab: TaskTab): boolean {
  const stage = uiStageIndex(task);
  switch (tab) {
    case "plan":
    case "grill":
      return task.mode !== "review";
    case "findings":
      return stage >= 4;
    case "checks":
      return task.mode !== "review" && stage >= 3;
    case "diff":
      return task.worktreePath !== null;
    case "artifacts":
      return task.mode !== "review" && task.worktreePath !== null;
    case "finish":
      return hasFinish(task);
    default:
      return true;
  }
}

/** The tab a task opens on: wherever the user is needed, else where the work is. */
export function defaultTab(task: Task): TaskTab {
  if (task.status === "needs-you") {
    switch (task.gate) {
      case "questions":
        return "grill";
      case "plan-approval":
        return "plan";
      case "triage":
        return task.mode === "review" ? "finish" : "findings";
      case "escalation":
        return "findings";
      case "finish":
        return "finish";
    }
  }
  if (task.status === "running" || task.status === "queued") {
    return task.stage ? "output" : "context";
  }
  if (task.status === "done") return "finish";
  return "context";
}

export interface BannerCopy {
  title: string;
  detail: string;
}

/** Why a needs-you task waits on the user, and what resolves it; or that it is finishing. */
export function gateBanner(
  task: Pick<Task, "gate" | "mode" | "delivering">,
  { openQuestions, blocking, round }: { openQuestions: number; blocking: number; round: number },
): BannerCopy {
  if (task.delivering) {
    return {
      title: "Finishing",
      detail:
        "Carrying out the actions you confirmed. Rebase conflicts go to the implementer, so this can take a while.",
    };
  }
  switch (task.gate) {
    case "questions":
      return {
        title: `${openQuestions} ${openQuestions === 1 ? "question needs" : "questions need"} your decision`,
        detail:
          "The plan reviewers asked things only you can answer. Answers go back to the planner, who revises the plan.",
      };
    case "plan-approval":
      return {
        title: "Plan ready for approval",
        detail: "Nothing in the worktree changes until you approve. Request changes to re-plan.",
      };
    case "triage":
      return task.mode === "review"
        ? {
            title: "Review ready to post",
            detail: "Pick the findings to post as review comments on the pull request.",
          }
        : {
            title:
              round === 0
                ? "First review paused for your triage"
                : `Fix round ${round} paused for your triage`,
            detail: `${blocking} gating ${blocking === 1 ? "finding" : "findings"}. Force fix or ignore them, then start fix round ${round + 1}.`,
          };
    case "escalation":
      return {
        title: `Review loop stopped after fix round ${round}`,
        detail: `${blocking} gating ${blocking === 1 ? "finding is" : "findings are"} still open. Accept the code as it is, or run one more fix round.`,
      };
    case "finish":
      return {
        title: "Ready to finish",
        detail: "Review exactly what leaves this machine, then confirm.",
      };
    default:
      return { title: "Needs you", detail: "" };
  }
}

/** Grill questions only the user can answer that are still open. */
export function openQuestionCount(questions: readonly GrillQuestion[]): number {
  return questions.filter((q) => q.needsHuman && q.answer === null).length;
}

// ---------------------------------------------------------------------------
// Diff comments
// ---------------------------------------------------------------------------

/**
 * Whether the user can comment on the diff's hunks: a work task waiting on
 * them at finish, triage or escalation, or a review task waiting at triage,
 * and not delivering.
 */
export function canCommentOnDiff(
  task: Pick<Task, "status" | "mode" | "gate" | "delivering">,
): boolean {
  if (task.status !== "needs-you" || task.delivering) return false;
  if (task.mode === "review") return task.gate === "triage";
  return task.gate === "finish" || task.gate === "triage" || task.gate === "escalation";
}

/**
 * Whether sending hunk comments starts a fix round straight away: a work task
 * at finish or escalation. A review task's comments only join its findings.
 */
export function diffCommentsRunFixRound(task: Pick<Task, "mode" | "gate">): boolean {
  return task.mode !== "review" && (task.gate === "finish" || task.gate === "escalation");
}

// ---------------------------------------------------------------------------
// Deleting findings and picking them to post
// ---------------------------------------------------------------------------

/**
 * Whether the user can delete a finding: a review task waiting at triage and
 * not delivering, and a finding neither merged into another nor fixed.
 */
export function canDeleteFinding(
  task: Pick<Task, "status" | "mode" | "gate" | "delivering">,
  finding: Pick<Finding, "status">,
): boolean {
  return (
    task.status === "needs-you" &&
    task.mode === "review" &&
    task.gate === "triage" &&
    !task.delivering &&
    finding.status !== "merged" &&
    finding.status !== "fixed"
  );
}

/**
 * Picks survive a delivery-plan refetch: earlier picks still offered stay,
 * newly offered findings start picked.
 */
export function carryPicks(
  previous: { offered: ReadonlySet<string>; picked: ReadonlySet<string> } | undefined,
  offered: readonly string[],
): Set<string> {
  if (!previous) return new Set(offered);
  return new Set(offered.filter((id) => previous.picked.has(id) || !previous.offered.has(id)));
}

// ---------------------------------------------------------------------------
// Stop, archive and delete
// ---------------------------------------------------------------------------

/** Queued and running tasks can be stopped. */
export function canStop(task: Pick<Task, "status">): boolean {
  return task.status === "queued" || task.status === "running";
}

/** Done tasks not yet archived can be archived; archiving keeps them done. */
export function canArchive(task: Pick<Task, "status" | "archivedAt">): boolean {
  return task.status === "done" && task.archivedAt === null;
}

/** An interrupted task the user stopped, as opposed to a shutdown or a usage limit. */
export function isStoppedByUser(task: Pick<Task, "status" | "error">): boolean {
  return task.status === "interrupted" && task.error === TASK_STOPPED_ERROR;
}

/**
 * Why the task cannot be deleted, or null when it can: once anything was
 * delivered, the branch, PR or comments it sent would outlive it. (A failed
 * delivery attempt that already sent something is refused by the server.)
 */
export function deleteBlockedReason(task: Pick<Task, "deliveryTargets">): string | null {
  return task.deliveryTargets.length > 0
    ? "Already delivered, so it stays: what it sent cannot be taken back here."
    : null;
}

/** What deleting the task removes, for the confirm dialog. */
export function deleteTaskCopy(
  task: Pick<Task, "status" | "origin" | "branch" | "worktreePath">,
): string {
  const stopFirst = canStop(task) ? "Stops the task, then removes " : "Removes ";
  if (!task.worktreePath) return `${stopFirst}the task and all run history.`;
  if (task.origin.kind === "github-pr") {
    return `${stopFirst}the worktree and all run history. The PR branch${task.branch ? ` ${task.branch}` : ""} stays.`;
  }
  return task.branch
    ? `${stopFirst}the worktree, the local branch ${task.branch} and all run history.`
    : `${stopFirst}the worktree and all run history.`;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** Findings to list: merged duplicates are folded into the finding they were merged into. */
export function visibleFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.status !== "merged");
}

/** A finding still gating the loop: Critical/High and neither fixed nor ignored, or force-fixed. */
export function isBlocking(finding: Pick<Finding, "severity" | "status">): boolean {
  return (
    finding.status === "force-fix" ||
    (isGatingSeverity(finding.severity) && finding.status === "open")
  );
}

export function severityCounts(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Open findings first, then by severity, then newest round first. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  const settled = (f: Finding) => (f.status === "fixed" ? 1 : 0);
  return findings.toSorted(
    (a, b) =>
      settled(a) - settled(b) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.round - a.round,
  );
}

/** `src/a.ts:12` or `src/a.ts:12-14`; null for findings not tied to a file. */
export function findingLocation(f: Pick<Finding, "file" | "lineStart" | "lineEnd">): string | null {
  if (!f.file) return null;
  if (f.lineStart == null) return f.file;
  const end = f.lineEnd != null && f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : "";
  return `${f.file}:${f.lineStart}${end}`;
}

// ---------------------------------------------------------------------------
// Agent output
// ---------------------------------------------------------------------------

export type TranscriptItem =
  | { kind: "message"; key: string; text: string }
  | {
      kind: "tool";
      key: string;
      name: string;
      target: string;
      input: unknown;
      output: string | null;
      isError: boolean;
    }
  | {
      kind: "subagent";
      key: string;
      /** The id of the `Agent` tool call that started the sub-agent. */
      id: string;
      name: string;
      target: string;
      agentType: string;
      description: string | null;
      input: unknown;
      /** The sub-agent's report: the `Agent` call's result, null while it runs. */
      output: string | null;
      isError: boolean;
      items: TranscriptItem[];
    }
  | { kind: "error"; key: string; message: string }
  | { kind: "check"; key: string; check: CheckRun }
  | { kind: "note"; key: string; text: string };

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
type SubagentItem = Extract<TranscriptItem, { kind: "subagent" }>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const TARGET_KEYS = ["file_path", "path", "command", "pattern", "url", "query", "description"];

/** The one argument that says what a tool call touched: a file, a command, a pattern. */
export function toolTarget(input: unknown): string {
  const fields = record(input);
  for (const key of TARGET_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) return value.trim().split("\n")[0]!;
  }
  if (input === undefined || input === null) return "";
  const json = JSON.stringify(input);
  return json === "{}" ? "" : json.length > 120 ? `${json.slice(0, 119)}…` : json;
}

/**
 * Folds a step's event log into what the transcript shows: assistant text,
 * tool calls paired with their results, errors and check commands. Session,
 * usage and result bookkeeping is left out. A sub-agent's messages and tool
 * calls (those with a `parentId`) nest under the `Agent` call that started
 * it; ones whose parent never showed up stay at the top level.
 */
export function buildTranscript(events: readonly StepEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  // Each tool call with the list that holds it, so it can become a sub-agent group in place.
  const tools = new Map<string, { item: ToolItem | SubagentItem; list: TranscriptItem[] }>();
  const groups = new Map<string, SubagentItem>();
  const checks = new Map<string, Extract<TranscriptItem, { kind: "check" }>>();

  const groupFor = (id: string): SubagentItem | undefined => {
    const existing = groups.get(id);
    if (existing) return existing;
    const tool = tools.get(id);
    if (!tool || tool.item.kind !== "tool") return undefined;
    const input = record(tool.item.input);
    const group: SubagentItem = {
      kind: "subagent",
      key: tool.item.key,
      id,
      name: tool.item.name,
      target: tool.item.target,
      agentType: typeof input.subagent_type === "string" ? input.subagent_type : "general-purpose",
      description: typeof input.description === "string" ? input.description : null,
      input: tool.item.input,
      output: tool.item.output,
      isError: tool.item.isError,
      items: [],
    };
    tool.list[tool.list.indexOf(tool.item)] = group;
    tools.set(id, { item: group, list: tool.list });
    groups.set(id, group);
    return group;
  };
  const listFor = (parentId: unknown): TranscriptItem[] =>
    (typeof parentId === "string" ? groupFor(parentId)?.items : undefined) ?? items;

  for (const event of events) {
    const payload = record(event.payload);
    const key = `${event.stepId}:${event.seq}`;
    switch (event.type) {
      case "message":
        if (typeof payload.text === "string" && payload.text.trim()) {
          listFor(payload.parentId).push({ kind: "message", key, text: payload.text });
        }
        break;
      case "tool-call-start": {
        const item = {
          kind: "tool" as const,
          key,
          name: typeof payload.name === "string" ? payload.name : "Tool",
          target: toolTarget(payload.input),
          input: payload.input,
          output: null,
          isError: false,
        };
        const list = listFor(payload.parentId);
        if (typeof payload.id === "string") tools.set(payload.id, { item, list });
        list.push(item);
        break;
      }
      case "subagent-start": {
        const group = typeof payload.id === "string" ? groupFor(payload.id) : undefined;
        if (group) {
          if (typeof payload.agentType === "string") group.agentType = payload.agentType;
          if (typeof payload.description === "string") group.description = payload.description;
        }
        break;
      }
      case "tool-call-end": {
        const item = typeof payload.id === "string" ? tools.get(payload.id)?.item : undefined;
        if (item) {
          item.output = typeof payload.output === "string" ? payload.output : "";
          item.isError = payload.isError === true;
        }
        break;
      }
      case "error":
        items.push({
          kind: "error",
          key,
          message: typeof payload.message === "string" ? payload.message : "The agent failed",
        });
        break;
      case "check.started": {
        const command = typeof payload.command === "string" ? payload.command : "";
        const item = {
          kind: "check" as const,
          key,
          check: { command, exitCode: null, output: "", timedOut: false, running: true },
        };
        checks.set(command, item);
        items.push(item);
        break;
      }
      case "check.finished": {
        const command = typeof payload.command === "string" ? payload.command : "";
        const check = finishedCheck(payload);
        const item = checks.get(command);
        if (item) item.check = check;
        else items.push({ kind: "check", key, check });
        break;
      }
      case "review.diff":
        items.push({ kind: "note", key, text: "Recorded the commit range for this review round" });
        break;
      case "issue.commented":
        items.push({
          kind: "note",
          key,
          text: `Commented on the issue: ${typeof payload.url === "string" ? payload.url : ""}`,
        });
        break;
    }
  }
  return items;
}

export type SubagentStatus = "running" | "done" | "failed" | "stopped";

/** A sub-agent group's status, from its `Agent` call's result and whether the step still runs. */
export function subagentStatus(
  item: Pick<SubagentItem, "output" | "isError">,
  live: boolean,
): SubagentStatus {
  if (item.isError) return "failed";
  if (item.output !== null) return "done";
  return live ? "running" : "stopped";
}

const ACTIVITY_CHARS = 120;

/**
 * What a running step is doing now, from its latest transcript item: a tool
 * call's name and target, a message's first line or an error. Null before
 * the first item. `parentId` scopes it to one agent of the step: left out,
 * every event counts, sub-agents' included; `null`, only the step's own
 * agent's events; a sub-agent's tool call id, only that sub-agent's events.
 */
export function currentActivity(
  events: readonly StepEvent[],
  parentId?: string | null,
): string | null {
  const scoped =
    parentId === undefined
      ? events
      : events.filter((event) => {
          const own = record(event.payload).parentId;
          return parentId === null ? typeof own !== "string" : own === parentId;
        });
  const item = buildTranscript(scoped).at(-1);
  return item ? activityText(item) : null;
}

/** One transcript item as a line of activity; a sub-agent group reads as its latest item. */
function activityText(item: TranscriptItem): string {
  switch (item.kind) {
    case "tool":
      return item.target ? `${item.name} ${item.target}` : item.name;
    case "subagent": {
      const last = item.items.at(-1);
      if (last) return activityText(last);
      return item.target ? `${item.name} ${item.target}` : item.name;
    }
    case "message": {
      const line =
        item.text
          .split("\n")
          .find((l) => l.trim())
          ?.trim() ?? "";
      return line.length > ACTIVITY_CHARS ? `${line.slice(0, ACTIVITY_CHARS - 1)}…` : line;
    }
    case "error":
      return item.message;
    case "check":
      return item.check.command;
    case "note":
      return item.text;
  }
}

/** Model the CLI reported for the step's session, if any. */
export function stepModel(events: readonly StepEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== "session") continue;
    const payload = record(event.payload);
    if (typeof payload.model === "string" && payload.model) return payload.model;
  }
  return null;
}

/** Where a step's displayed model comes from. */
export type ModelSource = "reported" | "configured" | "default";

/** Shown when neither the CLI nor the agent names a model. */
export const AUTO_MODEL_LABEL = "Auto";

export const MODEL_SOURCE_HINTS: Record<ModelSource, string> = {
  reported: "Reported by the CLI for this run.",
  configured: "Set on the agent; the CLI hasn't reported it yet.",
  default:
    "Auto: no model set on the agent, so the CLI uses its own default. Choose one in Settings → Agent library.",
};

/**
 * The model a step runs on: the one the CLI reported, else the agent's
 * configured model for the `cli` the step runs on, else null (the CLI's own
 * default).
 */
export function effectiveModel(
  events: readonly StepEvent[] | undefined,
  agent: Pick<Agent, "models"> | undefined,
  cli: AgentCli | null,
): { model: string | null; source: ModelSource } {
  const reported = events ? stepModel(events) : null;
  if (reported) return { model: reported, source: "reported" };
  const configured = cli ? agent?.models[cli] : undefined;
  if (configured) return { model: configured, source: "configured" };
  return { model: null, source: "default" };
}

/** Tooltip for a displayed model: the id, if any, and where it comes from. */
export function modelTitle({
  model,
  source,
}: {
  model: string | null;
  source: ModelSource;
}): string {
  const hint = MODEL_SOURCE_HINTS[source];
  return model ? `${model} — ${hint}` : hint;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export interface CheckRun {
  command: string;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  /** Started, not finished yet. */
  running: boolean;
}

function finishedCheck(payload: Record<string, unknown>): CheckRun {
  return {
    command: typeof payload.command === "string" ? payload.command : "",
    exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
    output: typeof payload.output === "string" ? payload.output : "",
    timedOut: payload.timedOut === true,
    running: false,
  };
}

/** The check commands a Checks step ran, in order, with their outcome. */
export function checkRuns(events: readonly StepEvent[]): CheckRun[] {
  return buildTranscript(events).flatMap((item) => (item.kind === "check" ? [item.check] : []));
}

export const checkPassed = (check: CheckRun) => !check.running && check.exitCode === 0;

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** A rebase onto main that stopped on conflicts the implementer resolves. */
export interface DeliveryConflict {
  branch: string;
  into: string;
  files: string[];
}

/** The rebase conflicts a delivery step handed to the implementer, in order. */
export function deliveryConflicts(events: readonly StepEvent[]): DeliveryConflict[] {
  return events.flatMap((event) => {
    if (event.type !== "delivery.conflict") return [];
    const payload = record(event.payload);
    return [
      {
        branch: typeof payload.branch === "string" ? payload.branch : "",
        into: typeof payload.into === "string" ? payload.into : "",
        files: Array.isArray(payload.files)
          ? payload.files.filter((f): f is string => typeof f === "string")
          : [],
      },
    ];
  });
}

/** The pull request a delivery opened, from its last `open-pr` outcome. */
export function pullRequestUrl(events: readonly StepEvent[]): string | undefined {
  return events
    .flatMap((event) => {
      if (event.type !== "delivery.done") return [];
      const payload = record(event.payload);
      if (payload.action !== "open-pr" || typeof payload.detail !== "string") return [];
      return /^https?:\/\/\S+$/.test(payload.detail) ? [payload.detail] : [];
    })
    .at(-1);
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx";
  text: string;
  /** Line number in the new file (old file for deletions); null for hunk headers. */
  line: number | null;
}

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

/** Splits a unified diff (`git diff`) into files with numbered lines. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(raw);
      file = { path: match?.[1] ?? raw.slice(11), additions: 0, deletions: 0, lines: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).replace(/^b\//, "");
      if (path !== "/dev/null") file.path = path;
      continue;
    }
    if (
      raw.startsWith("--- ") ||
      /^(index|new file|deleted file|similarity|rename|old mode|new mode|Binary)/.test(raw)
    ) {
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      file.lines.push({ kind: "hunk", text: raw, line: null });
    } else if (raw.startsWith("+")) {
      file.additions += 1;
      file.lines.push({ kind: "add", text: raw.slice(1), line: newLine++ });
    } else if (raw.startsWith("-")) {
      file.deletions += 1;
      file.lines.push({ kind: "del", text: raw.slice(1), line: oldLine++ });
    } else if (raw.startsWith(" ") || (raw === "" && file.lines.length > 0)) {
      file.lines.push({ kind: "ctx", text: raw.slice(1), line: newLine++ });
      oldLine++;
    }
  }
  // A trailing empty line from the split is not context.
  for (const f of files) {
    const last = f.lines.at(-1);
    if (last?.kind === "ctx" && last.text === "") f.lines.pop();
  }
  return files;
}

export function diffStat(files: readonly DiffFile[]): { additions: number; deletions: number } {
  return files.reduce(
    (sum, f) => ({
      additions: sum.additions + f.additions,
      deletions: sum.deletions + f.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

/** One hunk of a file's diff, as the step-through shows and comments on it. */
export interface DiffHunk {
  path: string;
  /** 0-based within its file. */
  index: number;
  /** The hunk header, then its lines. */
  lines: DiffLine[];
  /** Its lines in the new file; null when it only deletes from an emptied file. */
  lineStart: number | null;
  lineEnd: number | null;
  /** The hunk as unified-diff text, header included. */
  text: string;
}

const DIFF_PREFIX: Record<DiffLine["kind"], string> = { hunk: "", add: "+", del: "-", ctx: " " };

/**
 * Splits parsed files into their hunks. A hunk's range spans its added and
 * context lines; one that only deletes points at the line its header names.
 * Files without hunks (binary, mode-only) are skipped.
 */
export function splitHunks(files: readonly DiffFile[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (const file of files) {
    let index = 0;
    let current: DiffLine[] | undefined;
    const close = () => {
      if (!current) return;
      const [header, ...body] = current;
      const kept = body.filter((l) => l.kind !== "del").map((l) => l.line!);
      let lineStart: number | null = null;
      let lineEnd: number | null = null;
      if (kept.length > 0) {
        lineStart = Math.min(...kept);
        lineEnd = Math.max(...kept);
      } else {
        const start = Number(/^@@ -\S+ \+(\d+)/.exec(header!.text)?.[1] ?? 0);
        if (start > 0) lineStart = lineEnd = start;
      }
      hunks.push({
        path: file.path,
        index: index++,
        lines: current,
        lineStart,
        lineEnd,
        text: current.map((l) => `${DIFF_PREFIX[l.kind]}${l.text}`).join("\n"),
      });
    };
    for (const line of file.lines) {
      if (line.kind === "hunk") {
        close();
        current = [line];
      } else {
        current?.push(line);
      }
    }
    close();
  }
  return hunks;
}

/** Whether a suggested fix is a diff (rendered as one) rather than prose. */
export function looksLikeDiff(text: string): boolean {
  return /^(diff --git |@@ |--- )/m.test(text);
}

// ---------------------------------------------------------------------------
// Finish
// ---------------------------------------------------------------------------

export interface ActionCopy {
  title: string;
  /** Where it goes, in mono. */
  target: string;
  /** What is sent, verbatim (comment or PR body). */
  body?: string;
}

/**
 * Names a delivery action exactly: what is sent, and where. `picked` counts
 * the findings (`pr-review`) or follow-ups (`create-tasks`) the user picked.
 */
export function deliveryActionCopy(action: DeliveryAction, picked: number): ActionCopy {
  switch (action.kind) {
    case "push-branch":
      return { title: "Push branch", target: `${action.branch} → ${action.remote}` };
    case "open-pr":
      return {
        title: `Open pull request: ${action.title}`,
        target: `${action.host}/${action.owner}/${action.repo} · ${action.base} ← ${action.head}`,
        body: action.body,
      };
    case "pr-comment":
      return { title: "Comment on the pull request", target: action.url, body: action.body };
    case "jira-comment":
      return {
        title: `Comment on ${action.key}`,
        target: action.url ?? action.key,
        body: action.body,
      };
    case "issue-comment":
      return { title: "Comment on the issue", target: action.url, body: action.body };
    case "merge-main":
      return {
        title: `Merge into local ${action.into}`,
        target: `rebase ${action.branch} onto ${action.into}, then fast-forward. Never pushed.`,
      };
    case "pr-review":
      return {
        title: `Post review with ${picked} ${picked === 1 ? "comment" : "comments"}`,
        target: action.url,
      };
    case "create-tasks": {
      const repos = [...new Set(action.items.map((item) => item.repoName))];
      return {
        title: `Create ${picked} follow-up ${picked === 1 ? "task" : "tasks"}`,
        target: `waiting in the backlog of ${repos.join(", ")}`,
      };
    }
  }
}

/** The draft a new GitHub issue task offers to post on the issue when work starts. */
export const START_COMMENT_DRAFT = "Work on this issue has started in blackwall.";

/**
 * The draft plan-approval comment for a GitHub issue task: one sentence naming
 * the branch work goes on. The plan stays in blackwall.
 */
export function planApprovalComment(task: Pick<Task, "branch">): string {
  const branch = task.branch ? ` on branch \`${task.branch}\`` : "";
  return `The plan is approved. Implementation is starting${branch}.`;
}

/** `merge-main` and `create-tasks` never leave the machine; every other action does. */
export const isOutbound = (action: DeliveryAction) =>
  action.kind !== "merge-main" && action.kind !== "create-tasks";

// ---------------------------------------------------------------------------
// New task form
// ---------------------------------------------------------------------------

/** A Jira key typed or pasted as an issue link: `ABC-123`, or `https://x.atlassian.net/browse/ABC-123`. */
export function parseJiraInput(text: string): { key: string; url: string | null } | null {
  const value = text.trim();
  const key = value.toUpperCase();
  if (JIRA_KEY_PATTERN.test(key)) return { key, url: null };
  try {
    const url = new URL(value);
    const match =
      /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(url.pathname) ??
      /[?&]selectedIssue=([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(url.search);
    if (!match) return null;
    return { key: match[1]!.toUpperCase(), url: `${url.protocol}//${url.host}` };
  } catch {
    return null;
  }
}

/** The Jira site a key or issue link belongs to: the link's host, or the only Jira connection. */
export function jiraConnectionId(
  url: string | null,
  connections: readonly Pick<ConnectionView, "id" | "kind" | "baseUrl">[],
): string | null {
  const jira = connections.filter((c) => c.kind === "jira");
  if (url) {
    const host = new URL(url).host;
    return jira.find((c) => new URL(c.baseUrl).host === host)?.id ?? null;
  }
  return jira.length === 1 ? jira[0]!.id : null;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Web link for the task's origin: the PR or GitHub issue, or the Jira issue when its site is known. */
export function originUrl(
  task: Pick<Task, "origin">,
  connections: readonly ConnectionView[],
): string | null {
  const { origin } = task;
  if (origin.kind === "github-pr" || origin.kind === "github-issue") return origin.url;
  if (origin.kind !== "jira-issue") return null;
  const jira = connections.filter((c) => c.kind === "jira");
  const site = origin.connectionId
    ? jira.find((c) => c.id === origin.connectionId)
    : jira.length === 1
      ? jira[0]
      : undefined;
  return site ? `${site.baseUrl.replace(/\/+$/, "")}/browse/${origin.key}` : null;
}

export const STAGE_LABELS: Record<Stage, string> = {
  inform: "Inform",
  "plan-review": "Plan review",
  implement: "Implement",
  checks: "Checks",
  "code-review": "Code review",
  aggregate: "Aggregate",
  summarize: "Summarize",
};

/** Why a needs-you task waits, as the inbox card says it. */
export const GATE_REASONS: Record<Gate, string> = {
  questions: "Questions need your decision",
  "plan-approval": "Plan ready for approval",
  triage: "Findings ready for triage",
  escalation: "Review loop hit the round cap",
  finish: "Ready to finish",
};

/** The agent ids a task uses, every role, without duplicates. */
export function taskAgentIds(agents: RoleAgents): string[] {
  return [
    ...new Set([
      agents.planner,
      ...(agents.planReviewers ?? []),
      agents.implementer,
      ...(agents.codeReviewers ?? []),
      agents.summarizer,
    ]),
  ].filter((id): id is string => id !== undefined);
}

// ---------------------------------------------------------------------------
// Runs and steps
// ---------------------------------------------------------------------------

/** The review loop's current fix round: the highest round any step of the run reached. */
export function currentRound(steps: readonly Pick<Step, "round">[]): number {
  return steps.reduce((max, s) => Math.max(max, s.round), 0);
}

/** The most recent step of a stage, or undefined when the stage has not run. */
export function latestStep<S extends Pick<Step, "stage">>(
  steps: readonly S[],
  stage: Stage,
): S | undefined {
  return steps.findLast((s) => s.stage === stage);
}

/** The most recent harness step (no agent) of a stage, e.g. the delivery at finish. */
export function latestHarnessStep<S extends Pick<Step, "stage" | "agentId">>(
  steps: readonly S[],
  stage: Stage,
): S | undefined {
  return steps.findLast((s) => s.stage === stage && s.agentId === null);
}

/** The step to show first in Agent output: the running one, else the latest. */
export function defaultStepId(steps: readonly Pick<Step, "id" | "status">[]): string | null {
  return (steps.findLast((s) => s.status === "running") ?? steps.at(-1))?.id ?? null;
}

/** Grill questions answered by the planner, by the user, and still open for the user. */
export function grillCounts(questions: readonly GrillQuestion[]): {
  byPlanner: number;
  byUser: number;
  open: number;
} {
  return {
    byPlanner: questions.filter((q) => q.answeredBy === "agent").length,
    byUser: questions.filter((q) => q.answeredBy === "user").length,
    open: openQuestionCount(questions),
  };
}

/** The confirm button's label at finish: names how many actions go out. */
export function confirmLabel(count: number): string {
  if (count === 0) return "Keep local, mark done";
  return `Confirm and send ${count} ${count === 1 ? "action" : "actions"}`;
}

/** The distinct CLIs a task's agents run on, for the inbox card's agent tiles. */
export function agentClis(task: Pick<Task, "agents" | "cli" | "agentClis">): AgentCli[] {
  return [...new Set(taskAgentIds(task.agents).map((id) => agentCliFor(task, id)))];
}

/** The distinct CLIs a backlog item's agents would run on in a repo whose default is `repoCli`. */
export function backlogAgentClis(
  roles: RoleAgents,
  overrides: AgentClis,
  repoCli: AgentCli,
): AgentCli[] {
  return agentClis({ agents: roles, cli: repoCli, agentClis: overrides });
}

/**
 * The per-agent CLI choices that still matter: those for agents still chosen
 * that differ from the default `cli`. Stored choices are kept when the repo
 * changes, so switching back brings them back.
 */
export function activeOverrides(
  overrides: AgentClis,
  cli: AgentCli,
  chosenIds: readonly string[],
): AgentClis {
  const chosen = new Set(chosenIds);
  return Object.fromEntries(
    Object.entries(overrides).filter(([id, value]) => chosen.has(id) && value !== cli),
  );
}
