import {
  AGENT_CLIS,
  AGENT_ROLES,
  MAX_TITLE_CHARS,
  type Agent,
  type AgentCli,
  type AgentClis,
  type BacklogItemView,
  type IssueLookup,
  type OriginKind,
  type PrMode,
  type PullRequestLookup,
  type RepoView,
  type RoleAgents,
  type Task,
  type TaskOrigin,
  type TriageMode,
  type VoiceDraft,
} from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  ApiError,
  MissingCredentialError,
  createBacklogItem,
  lookupIssue,
  lookupPullRequest,
  submitVoiceDraft,
  updateBacklogItem,
} from "../api";
import { dependencyChoices, referenceRepoChoice, type ReferenceRepoPick } from "../backlog";
import { useWithCredential } from "../credentials";
import { originKey, statusLabel } from "../inbox";
import { isModKey, isPlainKey, isTypingTarget, modKeyLabel, useWindowKeydown } from "../keyboard";
import { cn } from "../lib/utils";
import {
  agentsQuery,
  backlogQuery,
  backlogRunnerQuery,
  clisQuery,
  connectionsQuery,
  queryKeys,
  reposQuery,
  roleDefaultsQuery,
  settingsQuery,
  taskQuery,
  tasksQuery,
} from "../query";
import { resolveSelectedRepo, useSelectedRepoId } from "../selected-repo";
import { draftFields } from "../voice";
import {
  CLI_NAMES,
  ROLE_LABELS,
  TRIAGE_OPTIONS,
  agentsForRole,
  errorMessage,
  isPanelRole,
  roleIds,
  withRole,
} from "../settings-forms";
import {
  START_COMMENT_DRAFT,
  activeOverrides,
  jiraConnectionId,
  parseJiraInput,
  taskAgentIds,
} from "../task-view";
import { AgentTile } from "./AgentTile";
import { CheckIcon, CloseIcon, SpinnerIcon, StarIcon, WarnIcon } from "./icons";
import { ORIGINS, PR_MODE_LABELS } from "./origins";
import { RepoMenuItems } from "./RepoMenuItems";
import { Segmented } from "./Segmented";
import { Button } from "./ui/button";
import { CheckChip } from "./ui/check-chip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { ErrorText, Field, fieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";
import { MultiSelectMenu } from "./ui/multi-select-menu";
import { Select } from "./ui/select";
import { SelectMenu, SelectMenuContent, SelectMenuTrigger } from "./ui/select-menu";
import { Textarea } from "./ui/textarea";

type Lookup<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; result: T }
  | { state: "error"; message: string };

/** Looks up a pasted PR or issue link, once typing pauses. */
function useOriginLookup<T>(url: string, lookupUrl: (url: string) => Promise<T>): Lookup<T> {
  const value = url.trim();
  const [settled, setSettled] = useState<{ url: string; lookup: Lookup<T> } | null>(null);
  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      lookupUrl(value).then(
        (result) => !cancelled && setSettled({ url: value, lookup: { state: "ok", result } }),
        (cause: unknown) =>
          !cancelled &&
          setSettled({ url: value, lookup: { state: "error", message: errorMessage(cause) } }),
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, lookupUrl]);
  if (!value) return { state: "idle" };
  return settled?.url === value ? settled.lookup : { state: "loading" };
}

/** A CLI's name, with a muted "Not installed" when detection says so. */
function CliName({ cli, installed }: { cli: AgentCli; installed: boolean | undefined }) {
  return (
    <>
      {CLI_NAMES[cli]}
      {installed === false && <span className="text-faint">Not installed</span>}
    </>
  );
}

function AgentsField({
  agents,
  roles,
  onChange,
  onReset,
  cli,
  agentClis,
  onAgentClisChange,
  advanced,
  onToggleAdvanced,
  cliStatus,
}: {
  agents: readonly Agent[];
  roles: RoleAgents;
  onChange: (roles: RoleAgents) => void;
  onReset: () => void;
  /** The repo's default CLI. */
  cli: AgentCli;
  /** Per-agent CLI choices, kept across repo changes; see {@link activeOverrides}. */
  agentClis: AgentClis;
  onAgentClisChange: (agentClis: AgentClis) => void;
  advanced: boolean;
  onToggleAdvanced: () => void;
  /** Whether each CLI is installed; undefined while unknown. */
  cliStatus: ReadonlyMap<AgentCli, boolean> | undefined;
}) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const chosen = taskAgentIds(roles).flatMap((id) => {
    const agent = byId.get(id);
    return agent ? [agent] : [];
  });
  const active = activeOverrides(agentClis, cli, taskAgentIds(roles));
  const overridden = chosen.filter((agent) => active[agent.id] !== undefined);
  const cliFor = (id: string) => active[id] ?? cli;

  function setCli(id: string, value: AgentCli) {
    const next = { ...agentClis };
    if (value === cli) delete next[id];
    else next[id] = value;
    onAgentClisChange(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <span className={fieldLabel}>Agents</span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={advanced}
          aria-controls="new-task-advanced"
          onClick={onToggleAdvanced}
        >
          Advanced
        </Button>
        <Button size="sm" variant="ghost" onClick={onReset}>
          Reset to defaults
        </Button>
      </div>
      <div className="bw-chamfer flex flex-col bg-card [--bw-chamfer-line:var(--border)]">
        {AGENT_ROLES.map((role, i) => {
          const eligible = agentsForRole(agents, role);
          const chosenIds = roleIds(roles, role);
          const id = `new-task-${role}`;
          return (
            <div
              key={role}
              className={cn(
                "grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2.5 px-3 py-2",
                i < AGENT_ROLES.length - 1 && "border-b border-border",
              )}
            >
              {isPanelRole(role) ? (
                <>
                  <span className="text-meta text-muted-foreground" id={`${id}-label`}>
                    {ROLE_LABELS[role]}
                  </span>
                  <div
                    role="group"
                    aria-labelledby={`${id}-label`}
                    className="flex flex-wrap gap-1"
                  >
                    {eligible.length === 0 && (
                      <span className="text-meta text-faint">No agent is eligible.</span>
                    )}
                    {eligible.map((agent) => (
                      <CheckChip
                        key={agent.id}
                        size="sm"
                        checked={chosenIds.includes(agent.id)}
                        onCheckedChange={(checked) =>
                          onChange(
                            withRole(
                              roles,
                              role,
                              checked
                                ? [...chosenIds, agent.id]
                                : chosenIds.filter((c) => c !== agent.id),
                            ),
                          )
                        }
                      >
                        {agent.name}
                      </CheckChip>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <label htmlFor={id} className="text-meta text-muted-foreground">
                    {ROLE_LABELS[role]}
                  </label>
                  <Select
                    id={id}
                    className="h-7 max-w-80"
                    value={chosenIds[0] ?? ""}
                    onChange={(event) => onChange(withRole(roles, role, [event.target.value]))}
                  >
                    <option value="">None</option>
                    {eligible.map((agent) => {
                      const model = agent.models[cliFor(agent.id)];
                      const effort = agent.efforts[cliFor(agent.id)];
                      return (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                          {model ? ` · ${model}` : ""}
                          {effort ? ` · ${effort}` : ""}
                        </option>
                      );
                    })}
                  </Select>
                </>
              )}
            </div>
          );
        })}
      </div>
      {!advanced && overridden.length > 0 && (
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-meta text-muted-foreground">
          Runs on another CLI:
          {overridden.map((agent) => (
            <span key={agent.id} className="inline-flex items-center gap-1.5">
              <AgentTile cli={cliFor(agent.id)} />
              {agent.name}
            </span>
          ))}
        </span>
      )}
      <div
        id="new-task-advanced"
        hidden={!advanced}
        className="bw-chamfer flex flex-col gap-2 bg-card px-3 py-2.5 [--bw-chamfer-line:var(--border)]"
      >
        <span className="inline-flex items-center gap-1.5 text-meta text-muted-foreground">
          Runs on <CliName cli={cli} installed={cliStatus?.get(cli)} /> by default (repo setting).
        </span>
        {chosen.length === 0 ? (
          <span className="text-meta text-faint">Choose agents above to set their CLI.</span>
        ) : (
          chosen.map((agent) => (
            <div
              key={agent.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-foreground-strong">{agent.name}</span>
                <span className="truncate text-label text-faint">
                  {AGENT_ROLES.filter((role) => roleIds(roles, role).includes(agent.id))
                    .map((role) => ROLE_LABELS[role])
                    .join(" · ")}
                </span>
              </span>
              <Segmented
                label={`CLI for ${agent.name}`}
                value={cliFor(agent.id)}
                onChange={(value) => setCli(agent.id, value)}
                options={AGENT_CLIS.map((option) => ({
                  value: option,
                  label: <CliName cli={option} installed={cliStatus?.get(option)} />,
                }))}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function DependsOnField({
  items,
  tasks,
  selfId,
  value,
  onChange,
}: {
  items: readonly BacklogItemView[];
  tasks: ReadonlyMap<string, Task>;
  selfId: string | undefined;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  // Other items still waiting (or paused), items whose task is running now, plus any already chosen.
  const choices = dependencyChoices(items, tasks, selfId, value);
  return (
    <div className="flex flex-col gap-1.5">
      <span className={fieldLabel} id="backlog-depends-label">
        Depends on <span className="font-normal text-faint">optional</span>
      </span>
      {choices.length === 0 ? (
        <span className="text-meta text-faint">No other items in this backlog.</span>
      ) : (
        <MultiSelectMenu
          id="backlog-depends"
          aria-labelledby="backlog-depends-label"
          options={choices.map((choice) => ({ id: choice.item.id, ...choice }))}
          value={value}
          onChange={onChange}
          optionText={(choice) => choice.item.title}
          trailing={({ task }) => task && <span className="text-faint">· {statusLabel(task)}</span>}
          placeholder="None"
          filterPlaceholder="Filter items…"
        />
      )}
      <span className="text-[11.5px] text-muted-foreground">
        The runner starts this item only once these are done, including tasks already running.
      </span>
    </div>
  );
}

function ReferenceReposField({
  repos,
  repoId,
  value,
  onChange,
}: {
  repos: readonly RepoView[];
  repoId: string;
  value: readonly string[];
  onChange: (value: string[]) => void;
}) {
  const otherRepos = repos.filter((other) => other.id !== repoId);
  return (
    <div className="flex flex-col gap-1.5">
      <span className={fieldLabel} id="new-task-reference-repos-label">
        Reference repos <span className="font-normal text-faint">optional</span>
      </span>
      {otherRepos.length === 0 ? (
        <span className="text-meta text-faint">No other repos registered.</span>
      ) : (
        // The server sorts favourites first.
        <MultiSelectMenu
          id="new-task-reference-repos"
          aria-labelledby="new-task-reference-repos-label"
          options={otherRepos}
          value={value}
          onChange={onChange}
          optionText={(other) => other.name}
          renderOption={(other) => (
            <>
              {other.favorite && <StarIcon size="sm" className="fill-current text-primary" />}
              <span className="truncate">{other.name}</span>
            </>
          )}
          placeholder="None"
          filterPlaceholder="Filter repos…"
        />
      )}
      <span className="text-[11.5px] text-muted-foreground">
        Read by this task's planner and reviewers, never written. Implementers stay in the worktree.
      </span>
    </div>
  );
}

function NewTaskForm({
  defaults,
  item,
  voiceDraft,
  onClose,
}: {
  defaults: RoleAgents;
  /** The backlog item to edit; without it the form creates a new task. */
  item: BacklogItemView | undefined;
  /**
   * The voice draft the form mirrors: it opens on a Blackwall task in the
   * draft's repo, takes each new revision's title and description, and
   * creates the task through the draft so it is created once.
   */
  voiceDraft?: VoiceDraft | undefined;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const withCredential = useWithCredential();
  const repos = useQuery(reposQuery);
  const agents = useQuery(agentsQuery);
  const connections = useQuery(connectionsQuery);
  const clis = useQuery(clisQuery);
  const cliStatus = clis.data
    ? new Map(clis.data.map((status) => [status.cli, status.installed]))
    : undefined;

  // Until the user picks an origin or types into the form, it follows the repo's default.
  const [kindChoice, setKindChoice] = useState<OriginKind | null>(voiceDraft ? "free-text" : null);
  const [jiraText, setJiraText] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [issueUrl, setIssueUrl] = useState("");
  // The "work started" comment is opt-in: unticked until the user ticks it.
  const [startCommentOn, setStartCommentOn] = useState(false);
  const [startComment, setStartComment] = useState(START_COMMENT_DRAFT);
  // New PR tasks default to Review PR.
  const [mode, setMode] = useState<PrMode>(item?.mode ?? "review");
  const [chosenRepo, setChosenRepo] = useState<string | null>(
    item?.repoId ?? voiceDraft?.repoId ?? null,
  );
  const [freeText, setFreeText] = useState(
    item?.freeText ?? (voiceDraft ? draftFields(voiceDraft).freeText : ""),
  );
  // The role defaults, under the edited backlog item's agents.
  const [roles, setRoles] = useState<RoleAgents>(() =>
    item ? { ...defaults, ...item.agents } : defaults,
  );
  const [agentClis, setAgentClis] = useState<AgentClis>(item?.agentClis ?? {});
  // Opens by itself when the edited item already runs an agent on another CLI.
  const [advanced, setAdvanced] = useState(() => {
    if (!item) return false;
    const itemRepoCli =
      (repos.data ?? []).find((r) => r.id === item.repoId)?.defaultCli ?? "claude";
    const itemChosenIds = taskAgentIds({ ...defaults, ...item.agents });
    return Object.keys(activeOverrides(item.agentClis, itemRepoCli, itemChosenIds)).length > 0;
  });
  // Backlog items run unattended, so they default to "Run and let me intervene" too.
  const [triageMode, setTriageMode] = useState<TriageMode>(item?.triageMode ?? "intervene");
  const [title, setTitle] = useState(
    item?.title ?? (voiceDraft ? draftFields(voiceDraft).title : ""),
  );
  // Each voice change of the draft overwrites what it covers.
  const [draftRevision, setDraftRevision] = useState(voiceDraft?.revision);
  if (voiceDraft && voiceDraft.revision !== draftRevision) {
    setDraftRevision(voiceDraft.revision);
    const fields = draftFields(voiceDraft);
    setTitle(fields.title);
    setFreeText(fields.freeText);
  }
  const [dependsOn, setDependsOn] = useState<string[]>(item?.dependsOn ?? []);
  // The reference repos the user picked, for the repo they were picked in; null follows the repo's.
  const [referencePick, setReferencePick] = useState<ReferenceRepoPick | null>(() =>
    item?.referenceRepoIds ? { repoId: item.repoId, ids: item.referenceRepoIds } : null,
  );
  const [localSubmitting, setSubmitting] = useState(false);
  // A voice "confirm" may be creating the draft's task from the server.
  const submitting = localSubmitting || !!voiceDraft?.submitting;
  const [error, setError] = useState<string | null>(null);

  const usableRepos = (repos.data ?? []).filter((r) => r.exists);
  const selectedRepo = resolveSelectedRepo(useSelectedRepoId(), usableRepos)?.id ?? null;
  // Leaves out the PR's repo: that lookup itself depends on the origin.
  const defaultKind =
    (repos.data ?? []).find(
      (r) =>
        r.id ===
        (chosenRepo ?? selectedRepo ?? (usableRepos.length === 1 ? usableRepos[0]!.id : null)),
    )?.defaultOrigin ?? "jira-issue";
  const kind = item?.origin.kind ?? kindChoice ?? defaultKind;
  const prLookup = useOriginLookup<PullRequestLookup>(
    kind === "github-pr" ? prUrl : "",
    lookupPullRequest,
  );
  const issueLookup = useOriginLookup<IssueLookup>(
    kind === "github-issue" ? issueUrl : "",
    lookupIssue,
  );
  const lookup = kind === "github-issue" ? issueLookup : prLookup;
  const jira = parseJiraInput(jiraText);
  const lookedUpRepo = lookup.state === "ok" ? lookup.result.repoId : null;
  // A pick wins, then the PR's or issue's own repo, then the globally selected one.
  const repoId =
    chosenRepo ??
    (kind === "github-pr" || kind === "github-issue" ? lookedUpRepo : null) ??
    selectedRepo ??
    (usableRepos.length === 1 ? usableRepos[0]!.id : null);
  const cli: AgentCli = (repos.data ?? []).find((r) => r.id === repoId)?.defaultCli ?? "claude";
  // Stored choices survive a repo change; only those that still differ are sent.
  const overrides = activeOverrides(agentClis, cli, taskAgentIds(roles));
  const { ids: referenceIds, override: refOverride } = referenceRepoChoice(
    (repos.data ?? []).find((r) => r.id === repoId),
    referencePick,
  );

  const backlogList = useQuery({ ...backlogQuery(repoId ?? ""), enabled: !!repoId });
  const runner = useQuery({ ...backlogRunnerQuery(repoId ?? ""), enabled: !!repoId && !item });
  const settings = useQuery(settingsQuery);
  const backlogItems = backlogList.data ?? [];
  const tasks = useQuery(tasksQuery);
  const tasksById = new Map((tasks.data ?? []).map((t) => [t.id, t]));
  // The repo can change after picking dependencies: keep only that repo's items.
  const chosenDeps = item
    ? dependsOn
    : dependsOn.filter((id) => backlogItems.some((i) => i.id === id));
  // Only a prediction (it cannot tell whether dependencies are done); the server decides.
  const runnerOn = !!settings.data?.backlogRunner && !!runner.data?.enabled;
  const footerHint = item
    ? "Waits in the backlog until you run it or the runner picks it."
    : !repoId
      ? "Added to the repo's backlog."
      : !runnerOn
        ? "Waits in this repo's backlog; its runner is off."
        : chosenDeps.length > 0
          ? "Starts now if its dependencies are done; otherwise the runner starts it once they are."
          : "Starts now: this repo's backlog runs.";

  function origin(): TaskOrigin | string {
    switch (kind) {
      case "jira-issue":
        if (!jira) return "Enter a Jira key like ABC-123, or paste the issue link";
        return {
          kind,
          key: jira.key,
          connectionId: jiraConnectionId(jira.url, connections.data ?? []),
        };
      case "github-pr":
        if (prLookup.state === "ok") return prLookup.result.origin;
        if (prLookup.state === "error") return prLookup.message;
        return "Paste the pull request link";
      case "github-issue":
        if (issueLookup.state === "ok") return issueLookup.result.origin;
        if (issueLookup.state === "error") return issueLookup.message;
        return "Paste the issue link";
      case "free-text":
        return { kind };
    }
  }

  async function submitEdit(edited: BacklogItemView) {
    if (kind === "free-text" && !freeText.trim()) return setError("Describe the task");
    const name = title.trim();
    if (!name) return setError("Give the item a title");
    setSubmitting(true);
    setError(null);
    try {
      await updateBacklogItem(edited.repoId, edited.id, {
        title: name,
        freeText,
        dependsOn: chosenDeps,
        agents: roles,
        agentClis: overrides,
        referenceRepoIds: refOverride,
        triageMode,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.backlog(edited.repoId) });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSubmitting(false);
    }
  }

  /** Adds the item to the repo's backlog; the server starts it at once when the backlog runs. */
  async function submit() {
    if (submitting) return;
    if (item) return submitEdit(item);
    const resolved = origin();
    if (typeof resolved === "string") return setError(resolved);
    if (!repoId) return setError("Pick the repository to work in");
    if (kind === "free-text" && !freeText.trim()) return setError("Describe the task");
    const comment = kind === "github-issue" && startCommentOn ? startComment.trim() : "";
    if (kind === "github-issue" && startCommentOn && !comment) {
      return setError("Write the comment, or untick it");
    }
    setSubmitting(true);
    setError(null);
    try {
      const input = {
        origin: resolved,
        mode: kind === "github-pr" ? mode : null,
        title: title.trim() || undefined,
        freeText,
        agents: roles,
        agentClis: overrides,
        referenceRepoIds: refOverride,
        triageMode,
        dependsOn: chosenDeps,
        start: true,
        ...(comment ? { startComment: { body: comment } } : {}),
      };
      const created = await withCredential(
        { label: "New task", target: originKey({ origin: resolved }) },
        // A voice draft is created through its claim on the server, so only once.
        () =>
          voiceDraft ? submitVoiceDraft(voiceDraft.id, input) : createBacklogItem(repoId, input),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.backlog(repoId) });
      const { taskId } = created;
      if (taskId) {
        const task = await queryClient.fetchQuery(taskQuery(taskId));
        queryClient.setQueryData<Task[]>(queryKeys.tasks, (tasks) =>
          tasks && !tasks.some((t) => t.id === task.id) ? [...tasks, task] : tasks,
        );
        onClose();
        void navigate({ to: "/tasks/$taskId", params: { taskId } });
      } else {
        onClose();
        void navigate({ to: "/repos/$repoId/backlog", params: { repoId } });
      }
    } catch (cause) {
      setError(
        cause instanceof MissingCredentialError
          ? "Cancelled: no token saved"
          : voiceDraft && cause instanceof ApiError && cause.status === 409
            ? "Already being created"
            : errorMessage(cause),
      );
      setSubmitting(false);
    }
  }

  // 1 / 2 / 3 / 4 pick the origin while no text field has focus.
  const editing = item !== undefined;
  useWindowKeydown((event) => {
    if (!isPlainKey(event) || isTypingTarget(event.target)) return;
    const index = ["1", "2", "3", "4"].indexOf(event.key);
    if (index === -1) return;
    event.preventDefault();
    setKindChoice(ORIGINS[index]!.value);
  }, !editing);

  const heading = item ? "Edit backlog item" : "New task";
  const itemRepo = item && (repos.data ?? []).find((r) => r.id === item.repoId);

  const repoHint =
    kind === "github-pr" && prLookup.state === "ok"
      ? prLookup.result.repoId
        ? "Matched from the PR remote."
        : `No registered repo has ${prLookup.result.origin.owner}/${prLookup.result.origin.repo} as its origin remote.`
      : kind === "github-issue" && issueLookup.state === "ok"
        ? issueLookup.result.repoId
          ? "Matched from the issue's repo."
          : `No registered repo has ${issueLookup.result.origin.owner}/${issueLookup.result.origin.repo} as its origin remote; pick the repo to work in.`
        : null;

  return (
    <form
      className="flex max-h-[calc(100vh_-_48px_-_var(--bw-titlebar-h))] flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && isModKey(event.nativeEvent)) {
          event.preventDefault();
          void submit();
        }
      }}
    >
      <div className="flex items-center gap-2.5 border-b border-border px-[18px] py-3.5">
        <DialogTitle>{heading}</DialogTitle>
        <DialogDescription className="sr-only">
          {item
            ? "Edit a backlog item; the backlog runner starts it when the repo is idle."
            : "Create a task from a Jira issue, a pull request, a GitHub issue or a description. It starts now when the repo's backlog runs; otherwise it waits in the backlog."}
        </DialogDescription>
        <span className="flex-1" />
        <Kbd aria-hidden="true">Esc</Kbd>
        <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-[18px] py-4">
        {item && (
          <Field label="Origin" group>
            <span className="mono text-[12.5px] text-muted-foreground">
              {originKey(item)}
              {item.mode && ` · ${PR_MODE_LABELS[item.mode]}`}
            </span>
          </Field>
        )}
        {item && kind === "free-text" && (
          <Field label="Description">
            <Textarea
              rows={4}
              value={freeText}
              onChange={(event) => setFreeText(event.target.value)}
            />
          </Field>
        )}
        {!item && (
          <div className="flex flex-col gap-2">
            <span className={fieldLabel}>Origin</span>
            <Segmented
              label="Origin"
              value={kind}
              onChange={(value) => {
                setKindChoice(value);
                setError(null);
              }}
              options={ORIGINS.map(({ value, label, icon: Icon }, i) => ({
                value,
                label: (
                  <>
                    <Icon size="sm" />
                    {label}
                    <Kbd aria-hidden="true">{i + 1}</Kbd>
                  </>
                ),
              }))}
            />
            {kind === "jira-issue" && (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="sr-only">Jira key or issue link</span>
                  <Input
                    autoFocus
                    className="mono text-[12.5px]"
                    placeholder="ABC-123 or https://acme.atlassian.net/browse/ABC-123"
                    value={jiraText}
                    onChange={(event) => {
                      setKindChoice(kind);
                      setJiraText(event.target.value);
                    }}
                  />
                </label>
                {jiraText.trim() && !jira && (
                  <span className="text-meta text-muted-foreground">
                    Expected a Jira key like ABC-123, or an issue link.
                  </span>
                )}
                {jira && (
                  <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
                    <CheckIcon size="sm" className="text-done" />
                    <span className="mono">{jira.key}</span>
                    <span>The title and description are read from Jira.</span>
                  </span>
                )}
              </>
            )}
            {kind === "github-pr" && (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="sr-only">Pull request URL</span>
                  <Input
                    autoFocus
                    type="url"
                    className="mono text-[12.5px]"
                    placeholder="https://github.com/owner/repo/pull/123"
                    value={prUrl}
                    onChange={(event) => {
                      setKindChoice(kind);
                      setPrUrl(event.target.value);
                    }}
                  />
                </label>
                {lookup.state === "loading" && (
                  <span className="text-meta text-muted-foreground">
                    Looking up the pull request…
                  </span>
                )}
                {lookup.state === "error" && (
                  <span className="flex items-center gap-1.5 text-meta text-failed">
                    <WarnIcon size="sm" />
                    {lookup.message}
                  </span>
                )}
                {lookup.state === "ok" && (
                  <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
                    <CheckIcon size="sm" className="text-done" />
                    <span className="mono">
                      {lookup.result.origin.owner}/{lookup.result.origin.repo}#
                      {lookup.result.origin.number}
                    </span>
                    {lookup.result.origin.connectionId === null && (
                      <span className="text-faint">· no connection for this host yet</span>
                    )}
                  </span>
                )}
              </>
            )}
            {kind === "github-issue" && (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="sr-only">Issue URL</span>
                  <Input
                    autoFocus
                    type="url"
                    className="mono text-[12.5px]"
                    placeholder="https://github.com/owner/repo/issues/123"
                    value={issueUrl}
                    onChange={(event) => {
                      setKindChoice(kind);
                      setIssueUrl(event.target.value);
                    }}
                  />
                </label>
                {issueLookup.state === "loading" && (
                  <span className="text-meta text-muted-foreground">Looking up the issue…</span>
                )}
                {issueLookup.state === "error" && (
                  <span className="flex items-center gap-1.5 text-meta text-failed">
                    <WarnIcon size="sm" />
                    {issueLookup.message}
                  </span>
                )}
                {issueLookup.state === "ok" && (
                  <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
                    <CheckIcon size="sm" className="text-done" />
                    <span className="mono">{originKey(issueLookup.result)}</span>
                    <span>The title and description are read from the issue.</span>
                    {issueLookup.result.origin.connectionId === null && (
                      <span className="text-faint">· no connection for this host yet</span>
                    )}
                  </span>
                )}
              </>
            )}
            {kind === "free-text" && (
              <label className="flex flex-col gap-1.5">
                <span className="sr-only">Task description</span>
                <Textarea
                  autoFocus
                  rows={4}
                  placeholder="What should the agents do? The first line becomes the title."
                  value={freeText}
                  onChange={(event) => {
                    setKindChoice(kind);
                    setFreeText(event.target.value);
                  }}
                />
              </label>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {kind === "github-pr" && !item && (
            <Field label="Mode" group>
              <Segmented
                label="Mode"
                value={mode}
                onChange={setMode}
                options={(["work", "review"] as const).map((value) => ({
                  value,
                  label: PR_MODE_LABELS[value],
                }))}
              />
              <span className="text-[11.5px] text-muted-foreground">
                {mode === "work"
                  ? "Agents commit to the PR branch."
                  : "Agents only review; you pick the findings to post."}
              </span>
            </Field>
          )}
          {item ? (
            <Field label="Repository" group>
              <span className="mono text-[12.5px] text-muted-foreground">
                {itemRepo?.name ?? item.repoId}
              </span>
            </Field>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="new-task-repo" className={fieldLabel}>
                Repository
              </label>
              {/* A voice draft belongs to its repo: the server creates it there. */}
              <SelectMenu
                value={repoId ?? ""}
                onValueChange={setChosenRepo}
                disabled={voiceDraft !== undefined}
              >
                <SelectMenuTrigger
                  id="new-task-repo"
                  placeholder="Choose a repo"
                  className="mono text-[12.5px]"
                />
                <SelectMenuContent>
                  <RepoMenuItems
                    repos={usableRepos}
                    trailing={(r) => (
                      <span className="mono block max-w-64 truncate text-faint">{r.path}</span>
                    )}
                  />
                </SelectMenuContent>
              </SelectMenu>
              {repoHint && <span className="text-[11.5px] text-muted-foreground">{repoHint}</span>}
              {repos.data && usableRepos.length === 0 && (
                <span className="text-[11.5px] text-muted-foreground">
                  No repos registered.{" "}
                  <Link
                    to="/settings/$section"
                    params={{ section: "repositories" }}
                    onClick={onClose}
                  >
                    Add one in Settings
                  </Link>
                </span>
              )}
            </div>
          )}
        </div>

        <Field
          label={
            <>
              Title{" "}
              {!item && (
                <span className="font-normal text-faint">
                  optional, defaults to{" "}
                  {kind === "free-text" ? "the first line" : "the issue or PR title"}
                </span>
              )}
            </>
          }
        >
          <Input
            maxLength={MAX_TITLE_CHARS}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        {repoId ? (
          <DependsOnField
            items={backlogItems}
            tasks={tasksById}
            selfId={item?.id}
            value={chosenDeps}
            onChange={setDependsOn}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className={fieldLabel}>
              Depends on <span className="font-normal text-faint">optional</span>
            </span>
            <span className="text-meta text-faint">Pick a repository first.</span>
          </div>
        )}
        {repoId && repos.data && (
          <ReferenceReposField
            repos={repos.data}
            repoId={repoId}
            value={referenceIds}
            onChange={(ids) => setReferencePick({ repoId, ids })}
          />
        )}

        {kind !== "free-text" && (
          <Field
            label={
              <>
                Context <span className="font-normal text-faint">optional</span>
              </>
            }
          >
            <Textarea
              rows={2}
              placeholder={
                kind === "github-pr" && mode === "review"
                  ? "Anything the reviewers should know that the pull request does not say."
                  : "Anything the planner should know that the origin does not say."
              }
              value={freeText}
              onChange={(event) => {
                setKindChoice(kind);
                setFreeText(event.target.value);
              }}
            />
          </Field>
        )}

        {kind === "github-issue" && !item && (
          <div className="flex flex-col gap-1.5">
            <label className="flex cursor-pointer items-center gap-2 text-foreground-strong">
              <input
                type="checkbox"
                className="focus:outline-none"
                checked={startCommentOn}
                onChange={(event) => setStartCommentOn(event.target.checked)}
              />
              <span className={fieldLabel}>Comment on the issue when work starts</span>
            </label>
            {startCommentOn && (
              <>
                <Textarea
                  rows={2}
                  aria-label="Start comment"
                  value={startComment}
                  onChange={(event) => setStartComment(event.target.value)}
                />
                <span className="text-[11.5px] text-muted-foreground">
                  Posted on the issue, signed as blackwall's, only if the task starts now.
                </span>
              </>
            )}
          </div>
        )}

        {agents.data && (
          <AgentsField
            agents={agents.data}
            roles={roles}
            onChange={setRoles}
            onReset={() => {
              setRoles(defaults);
              setAgentClis({});
              setReferencePick(null);
            }}
            cli={cli}
            agentClis={agentClis}
            onAgentClisChange={setAgentClis}
            advanced={advanced}
            onToggleAdvanced={() => setAdvanced((open) => !open)}
            cliStatus={cliStatus}
          />
        )}

        {!(kind === "github-pr" && mode === "review") && (
          <fieldset className="m-0 flex flex-col gap-2 border-none p-0">
            <legend className={cn(fieldLabel, "mb-2 p-0")}>Triage</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TRIAGE_OPTIONS.map((option) => (
                // The glow sits on an unclipped wrapper: clip-path drops the card's own shadow.
                <div
                  key={option.value}
                  className={cn(triageMode === option.value && "drop-shadow-glow-primary")}
                >
                  <label
                    className={cn(
                      "bw-chamfer bw-chamfer-has-focus flex h-full cursor-pointer gap-2.5 bg-card px-3 py-2.5 [--bw-chamfer-line:var(--border)]",
                      triageMode === option.value && "[--bw-chamfer-line:var(--primary)]",
                    )}
                  >
                    <input
                      type="radio"
                      name="triage"
                      className="mt-0.5 focus:outline-none"
                      checked={triageMode === option.value}
                      onChange={() => setTriageMode(option.value)}
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium text-foreground-strong">{option.title}</span>
                      <span className="text-meta text-muted-foreground">{option.detail}</span>
                    </span>
                  </label>
                </div>
              ))}
            </div>
          </fieldset>
        )}
      </div>

      <DialogFooter className="justify-start px-[18px]">
        {error ? (
          <ErrorText>{error}</ErrorText>
        ) : (
          <span className="text-[11.5px] text-faint">{footerHint}</span>
        )}
        <span className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={submitting}>
          {submitting && (
            <SpinnerIcon
              className="animate-spin"
              role="status"
              aria-hidden={false}
              aria-label="Saving"
            />
          )}
          {submitting ? (voiceDraft ? "Creating…" : "Saving…") : item ? "Save item" : "Create task"}
          <Kbd onFill aria-hidden="true">
            {modKeyLabel("↵")}
          </Kbd>
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The new task form, over the dimmed shell. Esc closes; ⌘↵ creates the task.
 * A new task is a backlog item of the chosen repo, started at once when the
 * repo's backlog runs. With `item` it edits that backlog item instead; with
 * `voiceDraft` it mirrors that voice draft (see `VoiceTaskModal`).
 */
export function NewTaskModal({
  open,
  onClose,
  item,
  voiceDraft,
}: {
  open: boolean;
  onClose: () => void;
  item?: BacklogItemView | undefined;
  voiceDraft?: VoiceDraft | undefined;
}) {
  const defaults = useQuery({ ...roleDefaultsQuery, enabled: open });
  // The form opens on the repo's default origin, so it waits for the repos too.
  const repos = useQuery({ ...reposQuery, enabled: open });
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-[680px]">
        {defaults.data && repos.data ? (
          <NewTaskForm
            defaults={defaults.data}
            item={item}
            voiceDraft={voiceDraft}
            onClose={onClose}
          />
        ) : (
          <div className="flex flex-col gap-2 px-5 py-6">
            <DialogTitle>{item ? "Edit backlog item" : "New task"}</DialogTitle>
            <DialogDescription className="m-0 text-muted-foreground">
              {defaults.isError
                ? defaults.error.message
                : repos.isError
                  ? repos.error.message
                  : "Loading…"}
            </DialogDescription>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
