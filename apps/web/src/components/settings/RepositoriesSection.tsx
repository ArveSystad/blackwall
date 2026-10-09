import { AGENT_CLIS, DEFAULT_REPO_SCAN_DEPTH, type RepoView } from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import {
  StaleRepoError,
  addRepo,
  deleteRepo,
  refreshRepo,
  scanRepos,
  suggestedChecks,
  updateRepo,
} from "../../api";
import { cn } from "../../lib/utils";
import { connectionsQuery, queryKeys, reposQuery } from "../../query";
import { CLI_NAMES, errorMessage, parseLines, sameList } from "../../settings-forms";
import { AgentTile } from "../AgentTile";
import { ConfirmDialog } from "../ConfirmDialog";
import { RepoIcon, WarnIcon } from "../icons";
import { ORIGINS } from "../origins";
import { Segmented } from "../Segmented";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Textarea } from "../ui/textarea";
import { Empty, ErrorText, SaveBar, SectionHeader, fieldLabel } from "./parts";

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
            <DialogTitle className="m-0 text-heading font-semibold text-foreground-strong">
              Add repositories
            </DialogTitle>
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
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{mode === "one" ? "Repo folder" : "Root folder"}</span>
              <Input
                className="mono"
                autoFocus
                required
                spellCheck={false}
                placeholder={mode === "one" ? "C:\\Code\\my-app" : "C:\\Code"}
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </label>
            {mode === "scan" && (
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>Depth</span>
                <Input
                  type="number"
                  min={0}
                  max={8}
                  className="w-24"
                  value={depth}
                  onChange={(event) => setDepth(event.target.value)}
                />
                <span className="text-meta text-muted-foreground">
                  Folder levels below the root. Skips node_modules, hidden folders and worktrees.
                </span>
              </label>
            )}
            {error && <ErrorText>{error}</ErrorText>}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border bg-card px-5 py-3">
            <Button variant="ghost" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={pending || !path.trim()}>
              {pending ? "Working…" : mode === "one" ? "Register repo" : "Scan and register"}
              <Kbd onFill aria-hidden="true">
                ↵
              </Kbd>
            </Button>
          </div>
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
  const [name, setName] = useState(repo.name);
  const [checks, setChecks] = useState(repo.checkCommands.join("\n"));
  const [defaultCli, setDefaultCli] = useState(repo.defaultCli);
  const [defaultOrigin, setDefaultOrigin] = useState(repo.defaultOrigin);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"suggest" | "refresh" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const dirty =
    name.trim() !== repo.name ||
    !sameList(parseLines(checks), repo.checkCommands) ||
    defaultCli !== repo.defaultCli ||
    defaultOrigin !== repo.defaultOrigin;
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
    setSaving(true);
    setError(null);
    try {
      await updateRepo(repo.id, {
        name: name.trim(),
        checkCommands: parseLines(checks),
        defaultCli,
        defaultOrigin,
      });
      await invalidate();
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
      <div className="flex min-h-[52px] items-center gap-2.5 border-b border-border px-5 py-3">
        <RepoIcon size="lg" className="text-muted-foreground" />
        <span className="truncate text-heading font-semibold text-foreground-strong">
          {repo.name}
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null || !repo.exists}
          onClick={() => void refresh()}
        >
          {busy === "refresh" ? "Reading…" : "Re-read remote"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => setConfirmRemove(true)}
        >
          Remove
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto px-5 py-[18px]">
        {!repo.exists && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-sev-medium/45 bg-sev-medium/8 px-3 py-2.5 text-sev-medium"
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
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Name</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={fieldLabel}>Path</span>
            <span className="mono flex h-[30px] items-center truncate text-muted-foreground">
              {repo.path}
            </span>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={fieldLabel}>Origin</span>
            <span className="mono flex h-[30px] items-center truncate text-muted-foreground">
              {repo.remoteUrl ?? "No origin remote"}
            </span>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={fieldLabel}>Connection</span>
            <span className="flex h-[30px] items-center truncate text-muted-foreground">
              {connection
                ? `${connection.name}${connection.hasToken ? "" : " (token missing)"}`
                : repo.remoteUrl
                  ? "None yet; added when a task needs it"
                  : "None"}
            </span>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={fieldLabel}>Default CLI</span>
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
              New tasks here start with this CLI&apos;s role defaults.
            </span>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={fieldLabel}>Default origin</span>
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
          </div>
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
          setError(null);
          setNotice(null);
        }}
        onSave={() => void save()}
      />

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

/** Repo registry: a list of repos beside the selected repo's editor. */
export function RepositoriesSection() {
  const repos = useQuery(reposQuery);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const list = repos.data ?? [];
  const selected = list.find((r) => r.id === selectedId) ?? list[0];

  return (
    <>
      <section
        aria-label="Repositories"
        className="flex w-[360px] shrink-0 flex-col border-r border-border"
      >
        <SectionHeader title="Repositories">
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
            + Add
          </Button>
        </SectionHeader>
        {message && (
          <p
            className="m-0 border-b border-border px-4 py-2 text-meta text-muted-foreground"
            role="status"
          >
            {message}
          </p>
        )}
        {repos.isPending ? (
          <Empty>Loading repositories…</Empty>
        ) : repos.isError ? (
          <Empty>{repos.error.message}</Empty>
        ) : list.length === 0 ? (
          <Empty>No repositories registered yet. Add one, or scan a folder of repos.</Empty>
        ) : (
          <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-auto p-1.5">
            {list.map((repo) => (
              <li key={repo.id}>
                <button
                  type="button"
                  aria-current={repo.id === selected?.id ? "true" : undefined}
                  onClick={() => setSelectedId(repo.id)}
                  className={cn(
                    "flex w-full cursor-pointer flex-col gap-0.5 rounded-lg border border-transparent bg-transparent px-2.5 py-2 text-left text-foreground hover:bg-card focus-visible:shadow-ring focus-visible:outline-none",
                    repo.id === selected?.id && "border-border-strong bg-muted hover:bg-muted",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium text-foreground-strong">{repo.name}</span>
                    <span className="flex-1" />
                    {repo.exists ? (
                      <span className="mono text-label text-faint">
                        {repo.checkCommands.length}{" "}
                        {repo.checkCommands.length === 1 ? "check" : "checks"}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-label text-sev-medium">
                        <WarnIcon size="sm" />
                        Folder missing
                      </span>
                    )}
                  </span>
                  <span className="mono truncate text-label text-muted-foreground">
                    {repo.path}
                  </span>
                </button>
              </li>
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
