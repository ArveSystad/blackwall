import type {
  ConnectionView,
  DataImportPreview,
  DataImportResult,
  MissingCredential,
} from "@blackwall/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { exportDataUrl, importData, previewImport } from "../../api";
import { importSummary } from "../../data-import";
import { cn } from "../../lib/utils";
import { queryKeys } from "../../query";
import { errorMessage } from "../../settings-forms";
import { ConfirmDialog } from "../ConfirmDialog";
import { editorBody, sectionLegend } from "../classes";
import { MissingTokenModal } from "../MissingTokenModal";
import { StatusBadge } from "../StatusBadge";
import { Button } from "../ui/button";
import { ErrorText, fieldLabel } from "../ui/field";
import { ImportReposDialog } from "./ImportReposDialog";
import { Empty, SectionHeader } from "./parts";

/** The connection's host, as the missing-token modal names it. */
function hostOf(connection: ConnectionView): string {
  try {
    return new URL(connection.baseUrl).host;
  } catch {
    return connection.name;
  }
}

function MissingTokenRow({
  connection,
  onSaved,
}: {
  connection: ConnectionView;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const missing: MissingCredential = {
    error: "MissingCredential",
    kind: connection.kind,
    host: hostOf(connection),
    connectionId: connection.id,
    message: "",
  };
  return (
    <li className="flex min-h-10 items-center gap-3 border-b border-border py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium text-foreground-strong">{connection.name}</span>
        <span className="mono truncate text-muted-foreground">{connection.baseUrl}</span>
      </div>
      <StatusBadge status="needs-you" label="Missing" />
      <Button size="sm" onClick={() => setOpen(true)}>
        Set token
      </Button>
      {open && (
        <MissingTokenModal
          missing={missing}
          action={{ label: "Set token", target: connection.name }}
          onSaved={() => {
            setOpen(false);
            onSaved();
            void queryClient.invalidateQueries({ queryKey: queryKeys.connections });
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </li>
  );
}

/** A list of repos under a label: the local name and folder, with a note per repo. */
function RepoList({
  label,
  items,
}: {
  label: string;
  items: { key: string; name: string; path: string; note: string }[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className={fieldLabel}>{label}</span>
      <ul className="m-0 list-none p-0">
        {items.map((item) => (
          <li key={item.key} className="flex min-h-10 items-center gap-3 border-b border-border">
            <span className="font-medium text-foreground-strong">{item.name}</span>
            <span className="mono min-w-0 flex-1 truncate text-muted-foreground">{item.path}</span>
            <span className="text-meta text-muted-foreground">{item.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the import added and skipped, and what still needs the user. */
function ImportReport({
  result,
  onTokenSaved,
}: {
  result: DataImportResult;
  onTokenSaved: (connectionId: string) => void;
}) {
  const { connectionsMissingToken, missingRepos, tasksMissingWorktree, matchedRepos } = result;
  const clean =
    connectionsMissingToken.length === 0 &&
    missingRepos.length === 0 &&
    tasksMissingWorktree.length === 0;
  return (
    <section aria-label="Import result" className="flex max-w-[720px] flex-col gap-4">
      <p className="m-0 text-meta text-muted-foreground">
        Import complete. Merged the export from {result.manifest.exportedAt.slice(0, 10)}. The
        previous data was backed up to{" "}
        <span className="mono break-all text-foreground">{result.backupPath}</span>.
      </p>
      <p className="m-0 text-foreground-strong">{importSummary(result.counts)}</p>
      {matchedRepos.length > 0 && (
        <RepoList
          label="Repositories matched by remote"
          items={matchedRepos.map((m) => ({
            key: m.importedId,
            name: m.name,
            path: m.path,
            note: m.importedName === m.name ? "merged" : `merged ${m.importedName}`,
          }))}
        />
      )}
      {result.repoDecisions.length > 0 && (
        <RepoList
          label="Your choices"
          items={result.repoDecisions.map((d) => ({
            key: d.importedId,
            name: d.importedName,
            path: d.importedPath,
            note: d.decision === "merge" ? `merged into ${d.name}` : "not imported",
          }))}
        />
      )}
      {clean && <Empty>All systems nominal. Nothing needs attention.</Empty>}
      {connectionsMissingToken.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={fieldLabel}>Connections without a token</span>
          <ul className="m-0 list-none p-0">
            {connectionsMissingToken.map((connection) => (
              <MissingTokenRow
                key={connection.id}
                connection={connection}
                onSaved={() => onTokenSaved(connection.id)}
              />
            ))}
          </ul>
        </div>
      )}
      {missingRepos.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={fieldLabel}>Repositories whose folder is missing</span>
          <span className="text-meta text-muted-foreground">
            Clone them to the same path, or remove them under Repositories.
          </span>
          <ul className="m-0 list-none p-0">
            {missingRepos.map((repo) => (
              <li key={repo.id} className="flex min-h-10 items-center gap-3 border-b border-border">
                <span className="font-medium text-foreground-strong">{repo.name}</span>
                <span className="mono truncate text-muted-foreground">{repo.path}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {tasksMissingWorktree.length > 0 && (
        <p className="m-0 text-meta text-muted-foreground">
          <span className="mono text-sev-medium">{tasksMissingWorktree.length}</span>{" "}
          {tasksMissingWorktree.length === 1 ? "task's worktree is" : "tasks' worktrees are"}{" "}
          missing. Their diffs are empty and they cannot resume until the worktree is back.
        </p>
      )}
    </section>
  );
}

/** Settings → Data: export everything but secrets to a zip, or merge one into the data. */
export function DataSection() {
  const [transcripts, setTranscripts] = useState(true);
  const [pending, setPending] = useState<{ file: File; preview: DataImportPreview } | null>(null);
  const [checking, setChecking] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [result, setResult] = useState<DataImportResult | null>(null);
  const input = useRef<HTMLInputElement>(null);

  /** Checks the picked file for repo conflicts before asking. */
  async function pick(file: File) {
    setChecking(true);
    setPreviewError(null);
    try {
      setPending({ file, preview: await previewImport(file) });
    } catch (cause) {
      setPreviewError(errorMessage(cause));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <SectionHeader title="Data" />
      <div className={cn(editorBody, "gap-6")}>
        <fieldset className="m-0 flex max-w-[720px] flex-col gap-4 border-none p-0">
          <legend className={sectionLegend}>Export</legend>
          <p className="m-0 text-meta text-muted-foreground">
            Downloads one zip with your settings, connections, repositories, agents, tags, backlog,
            tasks and memories. Tokens are never exported, and repo checkouts and worktrees are not
            included.
          </p>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              className="mt-[3px]"
              checked={transcripts}
              onChange={(event) => setTranscripts(event.target.checked)}
            />
            <span className="flex flex-col gap-0.5">
              <span className={fieldLabel}>Include agent transcripts</span>
              <span className="text-meta text-muted-foreground">
                Off: agents&apos; messages and tool calls are left out for a smaller file.
              </span>
            </span>
          </label>
          <div>
            <Button asChild>
              <a href={exportDataUrl(transcripts)} download>
                Export data
              </a>
            </Button>
          </div>
        </fieldset>

        <fieldset className="m-0 flex max-w-[720px] flex-col gap-4 border-none p-0">
          <legend className={sectionLegend}>Import</legend>
          <p className="m-0 text-meta text-muted-foreground">
            Adds what an export has that this machine doesn&apos;t. Rows already here are kept, and
            settings are unchanged. Refused while tasks run, are queued or are finishing.
          </p>
          <input
            ref={input}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            aria-label="Export archive"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void pick(file);
            }}
          />
          <div>
            <Button disabled={checking} onClick={() => input.current?.click()}>
              {checking ? "Checking…" : "Import data…"}
            </Button>
          </div>
          {previewError && <ErrorText>{previewError}</ErrorText>}
          {result && (
            <ImportReport
              result={result}
              onTokenSaved={(id) =>
                setResult({
                  ...result,
                  connectionsMissingToken: result.connectionsMissingToken.filter(
                    (c) => c.id !== id,
                  ),
                })
              }
            />
          )}
        </fieldset>
      </div>

      {pending && pending.preview.repoConflicts.length === 0 && (
        <ConfirmDialog
          title="Merge an export into blackwall?"
          confirmLabel="Import data"
          confirmVariant="default"
          onConfirm={async () => setResult(await importData(pending.file))}
          onClose={() => setPending(null)}
        >
          Tasks, repositories, memories and everything else in{" "}
          <span className="mono break-all text-foreground">{pending.file.name}</span> that this
          machine doesn&apos;t have are added. Existing rows and settings are kept. The current data
          is backed up first. Tokens are not in the export: connections need theirs entered again
          unless this machine&apos;s keychain already has them.
        </ConfirmDialog>
      )}
      {pending && pending.preview.repoConflicts.length > 0 && (
        <ImportReposDialog
          conflicts={pending.preview.repoConflicts}
          fileName={pending.file.name}
          onImport={async (decisions) => setResult(await importData(pending.file, decisions))}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}
