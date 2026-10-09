import {
  AGENT_ROLES,
  BACKLOG_PRIORITIES,
  MAX_TITLE_CHARS,
  PANEL_ROLES,
  type Agent,
  type AgentCli,
  type AgentRole,
  type BacklogItemView,
  type BacklogPriority,
  type OriginKind,
  type PrMode,
  type PullRequestLookup,
  type RoleAgents,
  type RoleDefaultsByCli,
  type Task,
  type TaskOrigin,
  type TriageMode,
} from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  MissingCredentialError,
  createBacklogItem,
  lookupPullRequest,
  updateBacklogItem,
} from "../api";
import { PRIORITY_LABELS } from "../backlog";
import { useWithCredential } from "../credentials";
import { originKey } from "../inbox";
import { isModKey, isPlainKey, isTypingTarget, modKeyLabel } from "../keyboard";
import { cn } from "../lib/utils";
import {
  agentsQuery,
  backlogQuery,
  backlogRunnerQuery,
  connectionsQuery,
  queryKeys,
  reposQuery,
  roleDefaultsQuery,
  settingsQuery,
  taskQuery,
} from "../query";
import { resolveSelectedRepo, useSelectedRepoId } from "../selected-repo";
import { ROLE_LABELS, agentsForRole, errorMessage } from "../settings-forms";
import { jiraConnectionId, parseJiraInput } from "../task-view";
import { AgentTile } from "./AgentTile";
import { CheckIcon, CloseIcon, WarnIcon } from "./icons";
import { ORIGINS } from "./origins";
import { Segmented } from "./Segmented";
import { ErrorText } from "./settings/parts";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";
import { Select } from "./ui/select";
import { Textarea } from "./ui/textarea";

const fieldLabel = "text-meta font-semibold text-foreground-strong";
const isPanel = (role: AgentRole) => (PANEL_ROLES as readonly AgentRole[]).includes(role);

function roleIds(roles: RoleAgents, role: AgentRole): string[] {
  const value = roles[role];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

type Lookup =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; result: PullRequestLookup }
  | { state: "error"; message: string };

function usePullRequestLookup(url: string): Lookup {
  const value = url.trim();
  const [settled, setSettled] = useState<{ url: string; lookup: Lookup } | null>(null);
  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      lookupPullRequest(value).then(
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
  }, [value]);
  if (!value) return { state: "idle" };
  return settled?.url === value ? settled.lookup : { state: "loading" };
}

function AgentsField({
  agents,
  roles,
  onChange,
  onReset,
}: {
  agents: readonly Agent[];
  roles: RoleAgents;
  onChange: (roles: RoleAgents) => void;
  onReset: () => void;
}) {
  function setRole(role: AgentRole, value: string[]) {
    const next: RoleAgents = { ...roles };
    if (isPanel(role)) Object.assign(next, { [role]: value });
    else if (value[0]) Object.assign(next, { [role]: value[0] });
    else delete next[role];
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center">
        <span className={fieldLabel}>Agents</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onReset}>
          Reset to defaults
        </Button>
      </div>
      <div className="flex flex-col rounded-lg border border-border bg-card">
        {AGENT_ROLES.map((role, i) => {
          const eligible = agentsForRole(agents, role);
          const chosen = roleIds(roles, role);
          const id = `new-task-${role}`;
          return (
            <div
              key={role}
              className={cn(
                "grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2.5 px-3 py-2",
                i < AGENT_ROLES.length - 1 && "border-b border-border",
              )}
            >
              {isPanel(role) ? (
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
                    {eligible.map((agent) => {
                      const on = chosen.includes(agent.id);
                      return (
                        <label
                          key={agent.id}
                          className={cn(
                            "inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-sm border border-input px-2 text-meta text-muted-foreground has-focus-visible:shadow-ring",
                            on && "border-primary text-foreground-strong",
                          )}
                        >
                          <input
                            type="checkbox"
                            className="focus:outline-none"
                            checked={on}
                            onChange={(event) =>
                              setRole(
                                role,
                                event.target.checked
                                  ? [...chosen, agent.id]
                                  : chosen.filter((c) => c !== agent.id),
                              )
                            }
                          />
                          <AgentTile cli={agent.cli} />
                          {agent.name}
                        </label>
                      );
                    })}
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
                    value={chosen[0] ?? ""}
                    onChange={(event) => setRole(role, [event.target.value])}
                  >
                    <option value="">None</option>
                    {eligible.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                        {agent.model ? ` · ${agent.model}` : ""}
                      </option>
                    ))}
                  </Select>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const TRIAGE_OPTIONS: { value: TriageMode; title: string; detail: string }[] = [
  {
    value: "intervene",
    title: "Run and let me intervene",
    detail: "Loops up to 3 fix rounds; stops for you on escalation.",
  },
  {
    value: "pause",
    title: "Pause each review round",
    detail: "You triage findings before every fix round.",
  },
];

function DependsOnField({
  items,
  selfId,
  value,
  onChange,
}: {
  items: readonly BacklogItemView[];
  selfId: string | undefined;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  // Other items still waiting (or paused), plus any already chosen.
  const choices = items.filter(
    (i) => i.id !== selfId && (i.status !== "promoted" || value.includes(i.id)),
  );
  return (
    <div className="flex flex-col gap-1.5">
      <span className={fieldLabel} id="backlog-depends-label">
        Depends on <span className="font-normal text-faint">optional</span>
      </span>
      <div role="group" aria-labelledby="backlog-depends-label" className="flex flex-wrap gap-1">
        {choices.length === 0 && (
          <span className="text-meta text-faint">No other items in this backlog.</span>
        )}
        {choices.map((choice) => {
          const on = value.includes(choice.id);
          return (
            <label
              key={choice.id}
              className={cn(
                "inline-flex h-6 max-w-72 cursor-pointer items-center gap-1.5 rounded-sm border border-input px-2 text-meta text-muted-foreground has-focus-visible:shadow-ring",
                on && "border-primary text-foreground-strong",
              )}
            >
              <input
                type="checkbox"
                className="focus:outline-none"
                checked={on}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...value, choice.id]
                      : value.filter((id) => id !== choice.id),
                  )
                }
              />
              <span className="truncate">{choice.title}</span>
            </label>
          );
        })}
      </div>
      <span className="text-[11.5px] text-muted-foreground">
        The runner starts this item only once these are done.
      </span>
    </div>
  );
}

function NewTaskForm({
  defaults,
  item,
  onClose,
}: {
  defaults: RoleDefaultsByCli;
  /** The backlog item to edit; without it the form creates a new task. */
  item: BacklogItemView | undefined;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const withCredential = useWithCredential();
  const repos = useQuery(reposQuery);
  const agents = useQuery(agentsQuery);
  const connections = useQuery(connectionsQuery);

  // Until the user picks an origin or types into the form, it follows the repo's default.
  const [kindChoice, setKindChoice] = useState<OriginKind | null>(null);
  const [jiraText, setJiraText] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [mode, setMode] = useState<PrMode>(item?.mode ?? "work");
  const [chosenRepo, setChosenRepo] = useState<string | null>(item?.repoId ?? null);
  const [freeText, setFreeText] = useState(item?.freeText ?? "");
  /** The role defaults of a CLI, under the edited backlog item's agents. */
  const startRoles = (cli: AgentCli): RoleAgents =>
    item ? { ...defaults[cli], ...item.agents } : defaults[cli];
  const [roles, setRoles] = useState<RoleAgents>(() => startRoles("claude"));
  // Until the user picks agents, they follow the role defaults of the repo's CLI.
  const [rolesEdited, setRolesEdited] = useState(false);
  const [rolesCli, setRolesCli] = useState<AgentCli>("claude");
  // Backlog items run unattended, so they default to "Run and let me intervene" too.
  const [triageMode, setTriageMode] = useState<TriageMode>(item?.triageMode ?? "intervene");
  const [title, setTitle] = useState(item?.title ?? "");
  const [priority, setPriority] = useState<BacklogPriority>(item?.priority ?? "normal");
  const [dependsOn, setDependsOn] = useState<string[]>(item?.dependsOn ?? []);
  const [submitting, setSubmitting] = useState(false);
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
  const lookup = usePullRequestLookup(kind === "github-pr" ? prUrl : "");
  const jira = parseJiraInput(jiraText);
  const lookedUpRepo = lookup.state === "ok" ? lookup.result.repoId : null;
  // A pick wins, then the PR's own repo, then the globally selected one.
  const repoId =
    chosenRepo ??
    (kind === "github-pr" ? lookedUpRepo : null) ??
    selectedRepo ??
    (usableRepos.length === 1 ? usableRepos[0]!.id : null);
  const cli = (repos.data ?? []).find((r) => r.id === repoId)?.defaultCli ?? "claude";
  if (cli !== rolesCli) {
    setRolesCli(cli);
    if (!rolesEdited) setRoles(startRoles(cli));
  }

  const backlogList = useQuery({ ...backlogQuery(repoId ?? ""), enabled: !!repoId });
  const runner = useQuery({ ...backlogRunnerQuery(repoId ?? ""), enabled: !!repoId && !item });
  const settings = useQuery(settingsQuery);
  const backlogItems = backlogList.data ?? [];
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
        if (lookup.state === "ok") return lookup.result.origin;
        if (lookup.state === "error") return lookup.message;
        return "Paste the pull request link";
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
        priority,
        dependsOn: chosenDeps,
        agents: roles,
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
    setSubmitting(true);
    setError(null);
    try {
      const created = await withCredential(
        { label: "New task", target: originKey({ origin: resolved }) },
        () =>
          createBacklogItem(repoId, {
            origin: resolved,
            mode: kind === "github-pr" ? mode : null,
            title: title.trim() || undefined,
            freeText,
            agents: roles,
            triageMode,
            priority,
            dependsOn: chosenDeps,
            start: true,
          }),
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
        cause instanceof MissingCredentialError ? "Cancelled: no token saved" : errorMessage(cause),
      );
      setSubmitting(false);
    }
  }

  // 1 / 2 / 3 pick the origin while no text field has focus.
  const editing = item !== undefined;
  useEffect(() => {
    if (editing) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!isPlainKey(event) || isTypingTarget(event.target)) return;
      const index = ["1", "2", "3"].indexOf(event.key);
      if (index === -1) return;
      event.preventDefault();
      setKindChoice(ORIGINS[index]!.value);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing]);

  const heading = item ? "Edit backlog item" : "New task";
  const itemRepo = item && (repos.data ?? []).find((r) => r.id === item.repoId);

  const repoHint =
    kind === "github-pr" && lookup.state === "ok"
      ? lookup.result.repoId
        ? "Matched from the PR remote."
        : `No registered repo has ${lookup.result.origin.owner}/${lookup.result.origin.repo} as its origin remote.`
      : null;

  return (
    <form
      className="flex max-h-[calc(100vh-48px)] flex-col"
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
        <DialogTitle className="m-0 text-heading font-semibold text-foreground-strong">
          {heading}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {item
            ? "Edit a backlog item; the backlog runner starts it when the repo is idle."
            : "Create a task from a Jira issue, a pull request or a description. It starts now when the repo's backlog runs; otherwise it waits in the backlog."}
        </DialogDescription>
        <span className="flex-1" />
        <Kbd aria-hidden="true">Esc</Kbd>
        <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-[18px] py-4">
        {item && (
          <div className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Origin</span>
            <span className="mono text-[12.5px] text-muted-foreground">
              {originKey(item)}
              {item.mode && ` · ${item.mode === "work" ? "Work on PR" : "Review PR"}`}
            </span>
          </div>
        )}
        {item && kind === "free-text" && (
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Description</span>
            <Textarea
              rows={4}
              value={freeText}
              onChange={(event) => setFreeText(event.target.value)}
            />
          </label>
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
            <div className="flex flex-col gap-1.5">
              <span className={fieldLabel}>Mode</span>
              <Segmented
                label="Mode"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "work", label: "Work on PR" },
                  { value: "review", label: "Review PR" },
                ]}
              />
              <span className="text-[11.5px] text-muted-foreground">
                {mode === "work"
                  ? "Agents commit to the PR branch."
                  : "Agents only review; you pick the findings to post."}
              </span>
            </div>
          )}
          {item ? (
            <div className="flex flex-col gap-1.5">
              <span className={fieldLabel}>Repository</span>
              <span className="mono text-[12.5px] text-muted-foreground">
                {itemRepo?.name ?? item.repoId}
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="new-task-repo" className={fieldLabel}>
                Repository
              </label>
              <Select
                id="new-task-repo"
                value={repoId ?? ""}
                onChange={(event) => setChosenRepo(event.target.value || null)}
              >
                <option value="">Choose a repo</option>
                {usableRepos.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.name} · {repo.path}
                  </option>
                ))}
              </Select>
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

        <label className="flex flex-col gap-1.5">
          <span className={fieldLabel}>
            Title{" "}
            {!item && (
              <span className="font-normal text-faint">
                optional, defaults to{" "}
                {kind === "free-text" ? "the first line" : "the issue or PR title"}
              </span>
            )}
          </span>
          <Input
            maxLength={MAX_TITLE_CHARS}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Priority</span>
          <Segmented
            label="Priority"
            value={priority}
            onChange={setPriority}
            options={BACKLOG_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
          />
        </div>
        {repoId ? (
          <DependsOnField
            items={backlogItems}
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

        {kind !== "free-text" && (
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>
              Context <span className="font-normal text-faint">optional</span>
            </span>
            <Textarea
              rows={2}
              placeholder="Anything the planner should know that the origin does not say."
              value={freeText}
              onChange={(event) => {
                setKindChoice(kind);
                setFreeText(event.target.value);
              }}
            />
          </label>
        )}

        {agents.data && (
          <AgentsField
            agents={agents.data}
            roles={roles}
            onChange={(next) => {
              setRolesEdited(true);
              setRoles(next);
            }}
            onReset={() => {
              setRolesEdited(false);
              setRoles(defaults[cli]);
            }}
          />
        )}

        {!(kind === "github-pr" && mode === "review") && (
          <fieldset className="m-0 flex flex-col gap-2 border-none p-0">
            <legend className={cn(fieldLabel, "mb-2 p-0")}>Triage</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TRIAGE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    "flex cursor-pointer gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 has-focus-visible:shadow-ring",
                    triageMode === option.value && "border-primary shadow-glow-primary",
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
              ))}
            </div>
          </fieldset>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border bg-card px-[18px] py-3">
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
          {submitting ? "Saving…" : item ? "Save item" : "Create task"}
          <Kbd onFill aria-hidden="true">
            {modKeyLabel("↵")}
          </Kbd>
        </Button>
      </div>
    </form>
  );
}

/**
 * The new task form, over the dimmed shell. Esc closes; ⌘↵ creates the task.
 * A new task is a backlog item of the chosen repo, started at once when the
 * repo's backlog runs. With `item` it edits that backlog item instead.
 */
export function NewTaskModal({
  open,
  onClose,
  item,
}: {
  open: boolean;
  onClose: () => void;
  item?: BacklogItemView | undefined;
}) {
  const defaults = useQuery({ ...roleDefaultsQuery, enabled: open });
  // The form opens on the repo's default origin, so it waits for the repos too.
  const repos = useQuery({ ...reposQuery, enabled: open });
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-[680px]">
        {defaults.data && repos.data ? (
          <NewTaskForm defaults={defaults.data} item={item} onClose={onClose} />
        ) : (
          <div className="flex flex-col gap-2 px-5 py-6">
            <DialogTitle className="m-0 text-heading font-semibold text-foreground-strong">
              {item ? "Edit backlog item" : "New task"}
            </DialogTitle>
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
