import {
  REPO_RENAME_STEPS,
  repoRenameInputSchema,
  type Repo,
  type RepoRenameResult,
  type RepoRenameStep,
  type RepoView,
  type Task,
} from "@blackwall/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { MissingCredentialError, renameRepo } from "../../api";
import { useWithCredential } from "../../credentials";
import { isModKey, modKeyLabel } from "../../keyboard";
import { cn } from "../../lib/utils";
import { queryKeys } from "../../query";
import {
  renamePreview,
  sessionResetTasks,
  stepStates,
  type RenameStepState,
} from "../../repo-rename";
import { errorMessage } from "../../settings-forms";
import { CheckIcon, WarnIcon } from "../icons";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { ErrorText, Field } from "../ui/field";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";

const STEP_LABELS: Record<RepoRenameStep, string> = {
  github: "Rename the repo on GitHub",
  origin: "Point origin at the new address",
  folder: "Rename the folder and its task worktrees",
  records: "Repair the worktrees and update blackwall's records",
};

const STATE_NOTES: Record<RenameStepState, string | null> = {
  done: "done",
  already: "already done",
  failed: "failed",
  "not-run": null,
};

/** The last segment of a folder path, either separator. */
function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/**
 * What a rename to `name` changes and the steps it takes, with each step's
 * state once it ran, and a warning naming the tasks whose agent session resets.
 */
export function RenamePlan({
  repo,
  name,
  result,
  resetTasks,
}: {
  repo: Pick<RepoView, "path" | "remoteUrl">;
  name: string;
  result: RepoRenameResult | null;
  resetTasks: readonly Task[];
}) {
  const preview = renamePreview(repo, name || "…");
  const states = stepStates(result);
  const rows: [string, string | null][] = [
    ["GitHub", preview.githubUrl],
    ["Origin", preview.origin],
    ["Folder", preview.path],
  ];
  return (
    <div className="flex flex-col gap-3">
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-meta text-faint">{label}</dt>
            <dd className="mono m-0 truncate text-foreground-strong" title={value ?? undefined}>
              {value ?? "—"}
            </dd>
          </div>
        ))}
      </dl>
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {REPO_RENAME_STEPS.map((step, index) => {
          const state = states[step];
          return (
            <li key={step} className="flex flex-col gap-0.5" data-step={step} data-state={state}>
              <span className="flex items-center gap-2">
                <span className="mono w-4 text-faint">{index + 1}.</span>
                <span
                  className={cn(
                    "text-foreground",
                    state === "failed" && "text-failed",
                    state === "already" && "text-muted-foreground",
                  )}
                >
                  {STEP_LABELS[step]}
                </span>
                {state === "done" && <CheckIcon size="sm" className="text-done" aria-hidden />}
                {STATE_NOTES[state] && (
                  <span
                    className={cn("text-meta", state === "failed" ? "text-failed" : "text-faint")}
                  >
                    {STATE_NOTES[state]}
                  </span>
                )}
              </span>
              {state === "failed" && result?.failed && (
                <span className="pl-6 text-meta text-failed">{result.failed.message}</span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="m-0 text-meta text-muted-foreground">
        Links in pull requests, issues and tasks keep the old address; GitHub redirects them as long
        as nobody takes the old name.
      </p>
      {resetTasks.length > 0 && (
        <div
          role="note"
          className="bw-chamfer flex items-start gap-2 bg-sev-medium/8 px-3 py-2.5 text-sev-medium [--bw-chamfer-line:color-mix(in_oklab,var(--sev-medium)_45%,transparent)]"
        >
          <WarnIcon size="lg" className="mt-0.5 shrink-0" />
          <span className="text-foreground">
            These tasks will start their next agent step in a fresh session:{" "}
            {resetTasks.map((task) => task.title).join(", ")}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Renames a GitHub repo everywhere in one go: on GitHub, in `origin`, the
 * folder on disk (with its task worktrees) and blackwall's records. A failed
 * step keeps the dialog open with the name locked; Retry resumes it.
 */
export function RenameRepoDialog({
  repo,
  tasks,
  onClose,
  onRenamed,
}: {
  repo: RepoView;
  tasks: readonly Task[];
  onClose: () => void;
  onRenamed: (repo: Repo) => void;
}) {
  const queryClient = useQueryClient();
  const withCredential = useWithCredential();
  const [name, setName] = useState(() => folderName(repo.path));
  const [result, setResult] = useState<RepoRenameResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Listed from the repo as it was, so a retry still names the same tasks.
  const [resetTasks] = useState(() => sessionResetTasks(repo, tasks));

  const trimmed = name.trim();
  const parsed = repoRenameInputSchema.safeParse({ name });
  const nameError =
    trimmed !== "" && !parsed.success ? (parsed.error.issues[0]?.message ?? null) : null;
  const retrying = result?.failed != null;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (pending || !parsed.success) return;
    setPending(true);
    setError(null);
    try {
      const next = await withCredential({ label: "Rename repo", target: repo.name }, () =>
        renameRepo(repo.id, parsed.data.name),
      );
      setResult(next);
      // A partial run changes things too, so refresh either way.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.repos }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
      ]);
      if (!next.failed) {
        onRenamed(next.repo);
        onClose();
      }
    } catch (cause) {
      setError(
        cause instanceof MissingCredentialError ? "Cancelled: no token saved" : errorMessage(cause),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[560px]">
        <form
          onSubmit={(event) => void submit(event)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && isModKey(event.nativeEvent)) {
              event.preventDefault();
              void submit();
            }
          }}
        >
          <div className="flex flex-col gap-3.5 px-5 pt-[18px] pb-[18px]">
            <DialogTitle>Rename repo</DialogTitle>
            <DialogDescription className="m-0 text-pretty">
              Renames <span className="mono text-foreground-strong">{repo.name}</span> on GitHub, in
              its origin remote and on disk. No task can start in it until the rename is done. A
              step that fails stops it; Retry picks up where it stopped.
            </DialogDescription>
            <Field label="New name">
              <Input
                className="mono"
                autoFocus
                required
                spellCheck={false}
                readOnly={retrying}
                aria-invalid={nameError !== null}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <RenamePlan repo={repo} name={trimmed} result={result} resetTasks={resetTasks} />
          </div>
          <DialogFooter className="justify-start">
            {error || nameError ? (
              <ErrorText>{error ?? nameError}</ErrorText>
            ) : (
              <span className="text-[11.5px] text-faint">
                The GitHub token needs admin rights on the repo.
              </span>
            )}
            <span className="flex-1" />
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={pending || !parsed.success}>
              {pending ? "Renaming…" : retrying ? "Retry" : "Rename repo"}
              <Kbd onFill aria-hidden="true">
                {modKeyLabel("↵")}
              </Kbd>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
