import type { DataImportDecisions, RepoConflict, RepoDecision } from "@blackwall/shared";
import { useState, type ReactNode } from "react";
import { conflictReason } from "../../data-import";
import { cn } from "../../lib/utils";
import { errorMessage } from "../../settings-forms";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { ErrorText, fieldLabel } from "../ui/field";

/** One side of a conflict: name, folder and remote. */
function RepoSide({
  label,
  name,
  path,
  remoteUrl,
}: {
  label: string;
  name: string;
  path: string;
  remoteUrl: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground-strong">{name}</span>
      <span className="mono break-all text-meta text-muted-foreground">{path}</span>
      <span className="mono break-all text-meta text-muted-foreground">
        {remoteUrl ?? "No remote"}
      </span>
    </div>
  );
}

function Choice({
  name,
  checked,
  onChange,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input type="radio" name={name} className="mt-[3px]" checked={checked} onChange={onChange} />
      <span>{children}</span>
    </label>
  );
}

/**
 * Asks, per imported repo that matches a local one ambiguously, whether to
 * merge it into the local repo or skip it with everything under it. Import
 * stays disabled until every repo has a choice; a failed import keeps the
 * dialog open with its error.
 */
export function ImportReposDialog({
  conflicts,
  fileName,
  onImport,
  onClose,
}: {
  conflicts: RepoConflict[];
  fileName: string;
  onImport: (decisions: DataImportDecisions) => Promise<unknown>;
  onClose: () => void;
}) {
  const [decisions, setDecisions] = useState<DataImportDecisions>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decided = conflicts.every((c) => decisions[c.importedId] !== undefined);

  const choose = (id: string, decision: RepoDecision) =>
    setDecisions((current) => ({ ...current, [id]: decision }));

  async function submit() {
    setPending(true);
    setError(null);
    try {
      await onImport(decisions);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[680px]">
        <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto px-5 pt-[18px] pb-4">
          <DialogTitle>Choose how to import these repositories</DialogTitle>
          <DialogDescription className="m-0 text-pretty">
            These repositories in <span className="mono break-all text-foreground">{fileName}</span>{" "}
            match one here only in part. Merge each into the local repository, or skip it.
          </DialogDescription>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {conflicts.map((conflict) => {
              const choice = decisions[conflict.importedId];
              return (
                <li
                  key={conflict.importedId}
                  className="flex flex-col gap-2 border-b border-border pb-3"
                >
                  <span className={cn(fieldLabel, "text-sev-medium")}>
                    {conflictReason(conflict)}
                  </span>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <RepoSide
                      label="In the export"
                      name={conflict.importedName}
                      path={conflict.importedPath}
                      remoteUrl={conflict.importedRemoteUrl}
                    />
                    <RepoSide
                      label="On this machine"
                      name={conflict.name}
                      path={conflict.path}
                      remoteUrl={conflict.remoteUrl}
                    />
                  </div>
                  <div
                    role="radiogroup"
                    aria-label={`Import ${conflict.importedName}`}
                    className="flex flex-col gap-1"
                  >
                    <Choice
                      name={`repo-${conflict.importedId}`}
                      checked={choice === "merge"}
                      onChange={() => choose(conflict.importedId, "merge")}
                    >
                      Merge into {conflict.name}
                    </Choice>
                    <Choice
                      name={`repo-${conflict.importedId}`}
                      checked={choice === "skip"}
                      onChange={() => choose(conflict.importedId, "skip")}
                    >
                      Skip (and its tasks, backlog, chats and memories)
                    </Choice>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="m-0 text-meta text-pretty text-muted-foreground">
            Only rows this machine doesn&apos;t have are added; existing rows and settings are kept.
            The current data is backed up first. Tokens are not in the export: connections need
            theirs entered again unless this machine&apos;s keychain already has them.
          </p>
          {error && <ErrorText>{error}</ErrorText>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!decided || pending} onClick={() => void submit()}>
            {pending ? "Working…" : "Import data"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
