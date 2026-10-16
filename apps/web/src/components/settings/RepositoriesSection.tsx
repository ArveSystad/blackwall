import {
  AGENT_CLIS,
  AGENT_TRUST_LEVELS,
  DEFAULT_REPO_SCAN_DEPTH,
  effectiveTrust,
  type RepoView,
} from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  StaleRepoError,
  addRepo,
  deleteRepo,
  refreshRepo,
  reorderRepos,
  scanRepos,
  suggestedChecks,
  updateRepo,
} from "../../api";
import { cn } from "../../lib/utils";
import { connectionsQuery, queryKeys, reposQuery, settingsQuery } from "../../query";
import { moveRepo, reorderRepoIds } from "../../repo-order";
import { CLI_NAMES, errorMessage, parseCap, parseLines, sameList } from "../../settings-forms";
import { TRUST_NAMES, trustRisk } from "../../trust";
import { AgentTile } from "../AgentTile";
import {
  editorBody,
  listPane,
  paneHeader,
  paneTitle,
  rowSelectable,
  rowSelected,
  sideList,
} from "../classes";
import { ConfirmDialog } from "../ConfirmDialog";
import { GripIcon, PlusIcon, RepoIcon, StarIcon, WarnIcon } from "../icons";
import { ORIGINS } from "../origins";
import { Segmented } from "../Segmented";
import { TrustBadge } from "../TrustBadge";
import { Button } from "../ui/button";
import { CheckChip } from "../ui/check-chip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { ErrorText, Field, fieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Textarea } from "../ui/textarea";
import { Empty, SaveBar, SectionHeader } from "./parts";

type AddMode = "one" | "scan";

function AddRepoDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (message: string, selectId?: string) => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<AddMode>("one");
  const [path, setPath] = useState("");
  const [depth, setDepth] = useState(String(DEFAULT_REPO_SCAN_DEPTH));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !path.trim()) return;
    setPending(true);
    setError(null);
    try {
      if (mode === "one") {
        const repo = await addRepo({ path: path.trim() });
        await queryClient.invalidateQueries({ queryKey: queryKeys.repos });
        onDone(`Registered ${repo.name}.`, repo.id);
      } else {
        const result = await scanRepos({ root: path.trim(), maxDepth: Number(depth) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.repos });
        const added = result.added.length;
        const skipped = result.skipped.length;
        onDone(
          `Found ${added + skipped} git ${added + skipped === 1 ? "repo" : "repos"}: ${added} registered, ${skipped} already registered.`,
          result.added[0]?.id,
        );
      }
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)}>
          <div className="flex flex-col gap-3.5 px-5 pt-[18px] pb-[18px]">
            <DialogTitle>Add repositories</DialogTitle>
            <DialogDescription className="m-0 text-pretty">
              Register one git repo, or scan a folder and register every repo inside it. Check
              commands are suggested from each repo&apos;s build files.
            </DialogDescription>
            <Segmented
              label="Add mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: "one", label: "One repo" },
                { value: "scan", label: "Scan a folder" },
              ]}
            />
            <Field label={mode === "one" ? "Repo folder" : "Root folder"}>
              <Input
                className="mono"
                autoFocus
                required
                spellCheck={false}
                placeholder={mode === "one" ? "C:\\Code\\my-app" : "C:\\Code"}
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </Field>
            {mode === "scan" && (
              <Field
                label="Depth"
                hint="Folder levels below the root. Skips node_modules, hidden folders and worktrees."
              >
                <Input
                  type="number"
                  min={0}
                  max={8}
                  className="w-24"
                  value={depth}
                  onChange={(event) => setDepth(event.target.value)}
                />
              </Field>
            )}
            {error && <ErrorText>{error}</ErrorText>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={pending || !path.trim()}>
              {pending ? "Working…" : mode === "one" ? "Register repo" : "Scan and register"}
              <Kbd onFill aria-hidden="true">
                ↵
              </Kbd>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RepoEditor({
  repo,
  onRemoved,
  onStale,
}: {
  repo: RepoView;
  onRemoved: () => void;
  /** The server found the folder gone (and removed the repo when it had no tasks). */
  onStale: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const connections = useQuery(connectionsQuery);
  const settings = useQuery(settingsQuery);
  const repos = useQuery(reposQuery);
  const [name, setName] = useState(repo.name);
  const [checks, setChecks] = useState(repo.checkCommands.join("\n"));
  const [defaultCli, setDefaultCli] = useState(repo.defaultCli);
  const [defaultOrigin, setDefaultOrigin] = useState(repo.defaultOrigin);
  const [defaultBranch, setDefaultBranch] = useState(repo.defaultBranch);
  const [backlogCap, setBacklogCap] = useState(
    repo.maxBacklogTasks === null ? "" : String(repo.maxBacklogTasks),
  );
  const [watchCi, setWatchCi] = useState(repo.watchCi);
  const [referenceRepoIds, setReferenceRepoIds] = useState(repo.referenceRepoIds);
  const [agentTrust, setAgentTrust] = useState(repo.agentTrust);
  const [trustProjectMcp, setTrustProjectMcp] = useState(repo.trustProjectMcp);
  const [trustProjectHooks, setTrustProjectHooks] = useState(repo.trustProjectHooks);
  const [confirmUnrestricted, setConfirmUnrestricted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"suggest" | "refresh" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Empty uses the global backlog cap.
  const backlogCapValue = backlogCap.trim() === "" ? null : parseCap(backlogCap);
  const backlogCapInvalid = backlogCap.trim() !== "" && backlogCapValue === null;
  const dirty =
    name.trim() !== repo.name ||
    !sameList(parseLines(checks), repo.checkCommands) ||
    defaultCli !== repo.defaultCli ||
    defaultOrigin !== repo.defaultOrigin ||
    defaultBranch.trim() !== repo.defaultBranch ||
    backlogCapInvalid ||
    backlogCapValue !== repo.maxBacklogTasks ||
    watchCi !== repo.watchCi ||
    !sameList([...referenceRepoIds].sort(), [...repo.referenceRepoIds].sort()) ||
    agentTrust !== repo.agentTrust ||
    trustProjectMcp !== repo.trustProjectMcp ||
    trustProjectHooks !== repo.trustProjectHooks;
  const otherRepos = repos.data?.filter((other) => other.id !== repo.id) ?? [];
  const connection = connections.data?.find((c) => c.id === repo.connectionId);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.repos });

  /** A stale repo was removed (or flagged) by the server; refresh the list either way. */
  async function failed(cause: unknown) {
    setError(errorMessage(cause));
    if (cause instanceof StaleRepoError) {
      onStale(cause.message);
      await invalidate();
    }
  }

  async function save() {
    if (!dirty || saving) return;
    if (defaultBranch.trim() === "") {
      setError("Default branch can't be empty");
      return;
    }
    if (backlogCapInvalid) {
      setError("Backlog tasks at once must be empty or a whole number from 1 to 20");
      return;
    }
    const branchChanged = defaultBranch.trim() !== repo.defaultBranch;
    setSaving(true);
    setError(null);
    try {
      await updateRepo(repo.id, {
        name: name.trim(),
        checkCommands: parseLines(checks),
        defaultCli,
        defaultOrigin,
        defaultBranch: defaultBranch.trim(),
        maxBacklogTasks: backlogCapValue,
        watchCi,
        referenceRepoIds,
        agentTrust,
        trustProjectMcp,
        trustProjectHooks,
      });
      await invalidate();
      // The Backlog header's ahead/behind is cached per repo and follows the branch.
      if (branchChanged) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.repoSync(repo.id) });
      }
      setNotice(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function suggest() {
    setBusy("suggest");
    setError(null);
    try {
      const suggested = await suggestedChecks(repo.id);
      setChecks(suggested.join("\n"));
      setNotice(
        suggested.length > 0
          ? "Suggested commands loaded. Save to keep them."
          : "No build files found to suggest commands from.",
      );
    } catch (cause) {
      await failed(cause);
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    setBusy("refresh");
    setError(null);
    try {
      await refreshRepo(repo.id);
      await invalidate();
      setNotice("Remote re-read.");
    } catch (cause) {
      await failed(cause);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Edit repository" className="flex min-w-0 flex-1 flex-col bg-sidebar">
      <div className={paneHeader}>
        <RepoIcon size="lg" className="text-muted-foreground" />
        <span className={paneTitle}>{repo.name}</span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null || !repo.exists}
          onClick={() => void refresh()}
        >
          {busy === "refresh" ? "Reading…" : "Re-read remote"}
        </Button>
        <Button size="sm" variant="destructive-ghost" onClick={() => setConfirmRemove(true)}>
          Remove
        </Button>
      </div>

      <div className={editorBody}>
        {!repo.exists && (
          <div
            role="alert"
            className="bw-chamfer flex items-start gap-2 bg-sev-medium/8 px-3 py-2.5 text-sev-medium [--bw-chamfer-line:color-mix(in_oklab,var(--sev-medium)_45%,transparent)]"
          >
            <WarnIcon size="lg" className="mt-0.5" />
            <span className="text-foreground">
              The folder <span className="mono text-foreground-strong">{repo.path}</span> no longer
              exists. Starting a task here removes the repo from the registry; remove it now or
              restore the folder.
            </span>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Path" group className="min-w-0">
            <span className="mono flex h-[30px] items-center truncate text-muted-foreground">
              {repo.path}
            </span>
          </Field>
          <Field label="Origin" group className="min-w-0">
            <span className="mono flex h-[30px] items-center truncate text-muted-foreground">
              {repo.remoteUrl ?? "No origin remote"}
            </span>
          </Field>
          <Field label="Connection" group className="min-w-0">
            <span className="flex h-[30px] items-center truncate text-muted-foreground">
              {connection
                ? `${connection.name}${connection.hasToken ? "" : " (token missing)"}`
                : repo.remoteUrl
                  ? "None yet; added when a task needs it"
                  : "None"}
            </span>
          </Field>
          <Field label="Default CLI" group className="min-w-0">
            <Segmented
              label="Default CLI"
              value={defaultCli}
              onChange={setDefaultCli}
              options={AGENT_CLIS.map((cli) => ({
                value: cli,
                label: (
                  <>
                    <AgentTile cli={cli} />
                    {CLI_NAMES[cli]}
                  </>
                ),
              }))}
            />
            <span className="text-meta text-faint">
              The CLI new tasks in this repo run their agents on.
            </span>
          </Field>
          <Field label="Default origin" group className="min-w-0">
            <Segmented
              label="Default origin"
              value={defaultOrigin}
              onChange={setDefaultOrigin}
              options={ORIGINS.map(({ value, label, icon: Icon }) => ({
                value,
                label: (
                  <>
                    <Icon size="sm" />
                    {label}
                  </>
                ),
              }))}
            />
            <span className="text-meta text-faint">
              New tasks and backlog items here start on this origin.
            </span>
          </Field>
          <Field
            label="Default branch"
            hint="Branch new tasks fork from, free-text tasks merge into and PRs target."
          >
            <Input
              className="mono"
              spellCheck={false}
              placeholder="main"
              aria-invalid={defaultBranch.trim() === ""}
              value={defaultBranch}
              onChange={(event) => setDefaultBranch(event.target.value)}
            />
          </Field>
          <Field
            label="Backlog tasks at once"
            hint="Backlog tasks running at once here. Empty uses the default from Settings → Backlog."
          >
            <Input
              type="number"
              min={1}
              max={20}
              className="mono w-20"
              placeholder={String(settings.data?.maxBacklogTasksPerRepo ?? "")}
              aria-invalid={backlogCapInvalid}
              value={backlogCap}
              onChange={(event) => setBacklogCap(event.target.value)}
            />
          </Field>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-[3px]"
            checked={watchCi}
            onChange={(event) => setWatchCi(event.target.checked)}
          />
          <span className="flex flex-col gap-0.5">
            <span className={fieldLabel}>Watch CI after push</span>
            <span className="text-meta text-muted-foreground">
              GitHub/GHE remotes only. Shows the pushed commit&apos;s checks on the task and offers
              Fix CI when they fail.
            </span>
          </span>
        </label>

        <div className="flex flex-col gap-1.5">
          <span className={fieldLabel} id="repo-agent-trust-label">
            Agent trust
          </span>
          <Segmented
            label="Agent trust"
            value={agentTrust}
            onChange={(level) => {
              // Unrestricted takes a confirmation; until then the selection stays.
              if (level === "unrestricted" && agentTrust !== "unrestricted") {
                setConfirmUnrestricted(true);
              } else {
                setAgentTrust(level);
              }
            }}
            options={AGENT_TRUST_LEVELS.map((level) => ({
              value: level,
              label: TRUST_NAMES[level],
            }))}
          />
          <ul
            aria-labelledby="repo-agent-trust-label"
            className={cn(
              "m-0 flex list-none flex-col gap-0.5 p-0 text-[11.5px]",
              agentTrust === "unrestricted" ? "text-failed" : "text-muted-foreground",
            )}
          >
            {trustRisk(agentTrust).map((line) => (
              <li key={line}>{line}</li>
            ))}
            <li className="text-faint">
              Review PR tasks, and PR tasks with commits that aren't yours, always run Locked.
            </li>
          </ul>
          {agentTrust === "trusted" && (
            <div className="flex flex-col gap-1.5 pt-1">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-[3px]"
                  checked={trustProjectMcp}
                  onChange={(event) => setTrustProjectMcp(event.target.checked)}
                />
                <span className="flex flex-col gap-0.5">
                  <span className={fieldLabel}>
                    Project MCP servers{" "}
                    <span className="font-normal text-faint">implement steps only</span>
                  </span>
                  <span className="text-meta text-muted-foreground">
                    Starts the servers in the repo's .mcp.json (OpenCode: its mcp config). They run
                    as you, outside the sandbox.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-[3px]"
                  checked={trustProjectHooks}
                  onChange={(event) => setTrustProjectHooks(event.target.checked)}
                />
                <span className="flex flex-col gap-0.5">
                  <span className={fieldLabel}>
                    Project hooks{" "}
                    <span className="font-normal text-faint">implement steps only</span>
                  </span>
                  <span className="text-meta text-muted-foreground">
                    Runs the hooks in the repo's .claude/settings.json (OpenCode: its plugins). They
                    run any command they name.
                  </span>
                </span>
              </label>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className={fieldLabel} id="repo-reference-repos-label">
            Reference repos <span className="font-normal text-faint">optional</span>
          </span>
          <div
            role="group"
            aria-labelledby="repo-reference-repos-label"
            className="flex flex-wrap gap-1"
          >
            {otherRepos.length === 0 && (
              <span className="text-meta text-faint">No other repos registered.</span>
            )}
            {otherRepos.map((other) => (
              <CheckChip
                key={other.id}
                size="sm"
                className="max-w-72"
                checked={referenceRepoIds.includes(other.id)}
                onCheckedChange={(checked) =>
                  setReferenceRepoIds((ids) =>
                    checked ? [...ids, other.id] : ids.filter((id) => id !== other.id),
                  )
                }
              >
                <span className="truncate">{other.name}</span>
              </CheckChip>
            ))}
          </div>
          <span className="text-[11.5px] text-muted-foreground">
            Read by planners, reviewers and chat, never written. Implementers stay in the worktree.
          </span>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2">
            <span className={fieldLabel}>Check commands</span>
            <span className="text-meta text-faint">
              One per line, run in order. Empty skips Checks.
            </span>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={busy !== null || !repo.exists}
              onClick={() => void suggest()}
            >
              {busy === "suggest" ? "Reading…" : "Reset to suggested"}
            </Button>
          </span>
          <Textarea
            className="mono min-h-32 bg-code text-code"
            spellCheck={false}
            value={checks}
            placeholder="pnpm test"
            onChange={(event) => setChecks(event.target.value)}
          />
        </label>
        {notice && <p className="m-0 text-meta text-muted-foreground">{notice}</p>}
      </div>

      <SaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        onDiscard={() => {
          setName(repo.name);
          setChecks(repo.checkCommands.join("\n"));
          setDefaultCli(repo.defaultCli);
          setDefaultOrigin(repo.defaultOrigin);
          setDefaultBranch(repo.defaultBranch);
          setBacklogCap(repo.maxBacklogTasks === null ? "" : String(repo.maxBacklogTasks));
          setWatchCi(repo.watchCi);
          setReferenceRepoIds(repo.referenceRepoIds);
          setAgentTrust(repo.agentTrust);
          setTrustProjectMcp(repo.trustProjectMcp);
          setTrustProjectHooks(repo.trustProjectHooks);
          setError(null);
          setNotice(null);
        }}
        onSave={() => void save()}
      />

      {confirmUnrestricted && (
        <ConfirmDialog
          title={`Run ${repo.name}'s agents Unrestricted?`}
          confirmLabel="Allow everything"
          onConfirm={async () => setAgentTrust("unrestricted")}
          onClose={() => setConfirmUnrestricted(false)}
        >
          Every CLI runs in its own allow-everything mode: agents can run any command, push, change
          remotes and read anywhere, with no sandbox. Review PR tasks and PR tasks with commits that
          aren't yours still run Locked. Takes effect when you save.
        </ConfirmDialog>
      )}
      {confirmRemove && (
        <ConfirmDialog
          title={`Remove ${repo.name}?`}
          confirmLabel="Remove repo"
          onConfirm={async () => {
            await deleteRepo(repo.id);
            await invalidate();
            onRemoved();
          }}
          onClose={() => setConfirmRemove(false)}
        >
          It is removed from the registry only; the folder on disk is not touched. Repos with tasks
          cannot be removed.
        </ConfirmDialog>
      )}
    </section>
  );
}

/** One repo in the list: drag (or Alt ↑/↓) to reorder within its group, star to pin it on top. */
function RepoRow({
  repo,
  selected,
  dragging,
  onSelect,
  onToggleFavorite,
  onDragStart,
  onDragEnd,
  onDrop,
  onMove,
}: {
  repo: RepoView;
  selected: boolean;
  dragging: RepoView | null;
  onSelect: () => void;
  onToggleFavorite: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  onMove: (delta: -1 | 1) => void;
}) {
  const dropTarget =
    dragging !== null && dragging.id !== repo.id && dragging.favorite === repo.favorite;
  return (
    <li
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (dropTarget) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      className={cn(
        "flex items-center gap-1 p-1",
        rowSelectable,
        selected && rowSelected,
        dragging?.id === repo.id && "opacity-50",
        dropTarget && "[--bw-chamfer-line:var(--border-strong)]",
      )}
    >
      <GripIcon className="cursor-grab text-faint" />
      <Button
        size="icon-sm"
        variant="ghost"
        aria-pressed={repo.favorite}
        aria-label="Favourite"
        title={repo.favorite ? "Unpin from the top" : "Pin to the top"}
        onClick={onToggleFavorite}
        className={cn(repo.favorite && "text-foreground-strong")}
      >
        <StarIcon className={cn(repo.favorite && "fill-current")} />
      </Button>
      <button
        type="button"
        data-repo-id={repo.id}
        aria-current={selected ? "true" : undefined}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        onClick={onSelect}
        onKeyDown={(event) => {
          if (!event.altKey || event.ctrlKey || event.metaKey) return;
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          onMove(event.key === "ArrowUp" ? -1 : 1);
        }}
        className="bw-chamfer bw-chamfer-focus flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 bg-transparent px-1.5 py-1 text-left text-foreground [--bw-chamfer-line:transparent] focus-visible:outline-none"
      >
        <span className="flex items-center gap-2">
          <span className="truncate font-medium text-foreground-strong">{repo.name}</span>
          <TrustBadge
            trust={effectiveTrust(repo, {
              origin: { kind: "free-text" },
              mode: null,
              prBranch: null,
            })}
          />
          <span className="flex-1" />
          {repo.exists ? (
            <span className="mono text-label text-faint">
              {repo.checkCommands.length} {repo.checkCommands.length === 1 ? "check" : "checks"}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-label text-sev-medium">
              <WarnIcon size="sm" />
              Folder missing
            </span>
          )}
        </span>
        <span className="mono truncate text-label text-muted-foreground">{repo.path}</span>
      </button>
    </li>
  );
}

/** Repo registry: a list of repos beside the selected repo's editor. */
export function RepositoriesSection() {
  const queryClient = useQueryClient();
  const repos = useQuery(reposQuery);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState<RepoView | null>(null);
  const focusAfter = useRef<string | null>(null);

  const list = repos.data ?? [];
  const selected = list.find((r) => r.id === selectedId) ?? list[0];

  // Keeps keyboard focus on a row Alt ↑/↓ just moved.
  useEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    document.querySelector<HTMLElement>(`[data-repo-id="${CSS.escape(id)}"]`)?.focus();
  }, [repos.data]);

  /** Shows the new list at once, then saves it; a failure is shown and the list re-read. */
  async function save(optimistic: RepoView[], request: () => Promise<unknown>) {
    queryClient.setQueryData<RepoView[]>(queryKeys.repos, optimistic);
    try {
      await request();
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      await queryClient.invalidateQueries({ queryKey: queryKeys.repos });
    }
  }

  function reorder(ids: string[] | null, focusId?: string) {
    if (!ids) return;
    const byId = new Map(list.map((r) => [r.id, r]));
    if (focusId) focusAfter.current = focusId;
    void save(
      ids.map((id) => byId.get(id)!),
      () => reorderRepos(ids),
    );
  }

  function toggleFavorite(repo: RepoView) {
    const favorite = !repo.favorite;
    const updated = list.map((r) => (r.id === repo.id ? { ...r, favorite } : r));
    // The server's order: favourites first, each group keeping its relative order.
    void save([...updated.filter((r) => r.favorite), ...updated.filter((r) => !r.favorite)], () =>
      updateRepo(repo.id, { favorite }),
    );
  }

  return (
    <>
      <section aria-label="Repositories" className={listPane}>
        <SectionHeader title="Repositories">
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
            <PlusIcon />
            Add
          </Button>
        </SectionHeader>
        <p className="m-0 border-b border-border px-4 py-1.5 text-label text-faint">
          Drag to reorder · ★ pins to the top
        </p>
        {message && (
          <p
            className="m-0 border-b border-border px-4 py-2 text-meta text-muted-foreground"
            role="status"
          >
            {message}
          </p>
        )}
        {repos.isPending ? (
          <Empty>Reading registered repos…</Empty>
        ) : repos.isError ? (
          <Empty>{repos.error.message}</Empty>
        ) : list.length === 0 ? (
          <Empty>No repos on the board. Add one, or scan a folder of repos.</Empty>
        ) : (
          <ul className={sideList}>
            {list.map((repo) => (
              <RepoRow
                key={repo.id}
                repo={repo}
                selected={repo.id === selected?.id}
                dragging={dragging}
                onSelect={() => setSelectedId(repo.id)}
                onToggleFavorite={() => toggleFavorite(repo)}
                onDragStart={() => setDragging(repo)}
                onDragEnd={() => setDragging(null)}
                onDrop={() => {
                  if (dragging) reorder(reorderRepoIds(list, dragging.id, repo.id));
                  setDragging(null);
                }}
                onMove={(delta) => reorder(moveRepo(list, repo.id, delta), repo.id)}
              />
            ))}
          </ul>
        )}
      </section>
      {selected ? (
        <RepoEditor
          key={selected.id}
          repo={selected}
          onRemoved={() => setSelectedId(null)}
          onStale={setMessage}
        />
      ) : (
        <div className="flex-1 bg-sidebar" />
      )}
      {adding && (
        <AddRepoDialog
          onClose={() => setAdding(false)}
          onDone={(text, id) => {
            setAdding(false);
            setMessage(text);
            if (id) setSelectedId(id);
          }}
        />
      )}
    </>
  );
}
