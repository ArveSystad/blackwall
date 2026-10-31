import type { RepoCommitResult, RepoTree, RepoView } from "@blackwall/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError, commitRepo } from "../api";
import { changeLetter } from "../code-view";
import { isModKey, modKeyLabel } from "../keyboard";
import { queryKeys } from "../query";
import { errorMessage } from "../settings-forms";
import { SpinnerIcon, WarnIcon } from "./icons";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { ErrorText, Field } from "./ui/field";
import { Kbd } from "./ui/kbd";
import { Textarea } from "./ui/textarea";

/**
 * Commits every change in the repo's own folder, after the user wrote a
 * message and saw the files and the branch. Never pushes. A 409 (a hook
 * rejected it, or the checkout moved to another branch) stays open with the
 * server's message and rereads the tree, so the title shows the new branch.
 */
export function CommitDialog({
  repo,
  tree,
  onClose,
  onCommitted,
}: {
  repo: Pick<RepoView, "id" | "path" | "defaultBranch">;
  tree: RepoTree;
  onClose: () => void;
  onCommitted: (result: RepoCommitResult) => void;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const changed = tree.files.filter((file) => file.change !== null);
  const task = tree.activeInRepoTask;

  async function submit() {
    if (submitting) return;
    if (message.trim() === "") {
      setError("Write a commit message");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await commitRepo(repo.id, { message, branch: tree.branch });
      void queryClient.invalidateQueries({ queryKey: queryKeys.repoCode(repo.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.repoSync(repo.id) });
      onCommitted(result);
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status === 409) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.repoCode(repo.id) });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-[560px]">
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
          <div className="flex flex-col gap-1.5 border-b border-border px-[18px] py-3.5">
            <DialogTitle>
              Commit to <span className="mono">{tree.branch}</span>
            </DialogTitle>
            <DialogDescription className="m-0 text-muted-foreground">
              Stages every change in <span className="mono">{repo.path}</span> and commits it.
              Nothing is pushed. A message without a type gets <span className="mono">chore:</span>.
            </DialogDescription>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-[18px] py-4">
            {task && (
              <p className="m-0 flex gap-2 text-needs" role="note">
                <WarnIcon className="mt-0.5" />
                <span>
                  Task{" "}
                  <Link to="/tasks/$taskId" params={{ taskId: task.id }} className="font-medium">
                    {task.title}
                  </Link>{" "}
                  is working in this folder. This commit lands on its branch{" "}
                  <span className="mono">{tree.branch}</span> and includes the agent&apos;s
                  unfinished changes.
                </span>
              </p>
            )}
            {tree.branch !== repo.defaultBranch && (
              <p className="m-0 text-muted-foreground">
                The Backlog&apos;s Push only covers{" "}
                <span className="mono">{repo.defaultBranch}</span>, so push this commit outside
                blackwall.
              </p>
            )}
            <Field label="Message">
              <Textarea
                rows={3}
                autoFocus
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
            </Field>
            <div className="flex flex-col gap-1">
              <span className="label text-muted-foreground">
                {changed.length} changed {changed.length === 1 ? "file" : "files"}
              </span>
              <ul className="m-0 flex max-h-48 list-none flex-col overflow-auto p-0">
                {changed.map((file) => (
                  <li key={file.path} className="mono flex gap-2 text-[12.5px]">
                    <span className="w-3 text-muted-foreground">{changeLetter(file.change)}</span>
                    <span className="min-w-0 truncate" title={file.path}>
                      {file.path}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <DialogFooter className="justify-start px-[18px]">
            {error ? (
              <ErrorText>{error}</ErrorText>
            ) : (
              <span className="text-[11.5px] text-faint">Hooks run as for any commit.</span>
            )}
            <span className="flex-1" />
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={submitting || changed.length === 0}>
              {submitting && (
                <SpinnerIcon
                  className="animate-spin"
                  role="status"
                  aria-hidden={false}
                  aria-label="Committing"
                />
              )}
              {submitting
                ? "Committing…"
                : `Commit ${changed.length} ${changed.length === 1 ? "file" : "files"}`}
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
