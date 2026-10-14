import type { ConnectionView, DataImportResult, MissingCredential } from "@blackwall/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { exportDataUrl, importData } from "../../api";
import { cn } from "../../lib/utils";
import { queryKeys } from "../../query";
import { ConfirmDialog } from "../ConfirmDialog";
import { editorBody, sectionLegend } from "../classes";
import { MissingTokenModal } from "../MissingTokenModal";
import { StatusBadge } from "../StatusBadge";
import { Button } from "../ui/button";
import { fieldLabel } from "../ui/field";
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

/** What the import replaced and what still needs the user. */
function ImportReport({
  result,
  onTokenSaved,
}: {
  result: DataImportResult;
  onTokenSaved: (connectionId: string) => void;
}) {
  const { connectionsMissingToken, missingRepos, tasksMissingWorktree } = result;
  const clean =
    connectionsMissingToken.length === 0 &&
    missingRepos.length === 0 &&
    tasksMissingWorktree.length === 0;
  return (
    <section aria-label="Import result" className="flex max-w-[720px] flex-col gap-4">
      <p className="m-0 text-meta text-muted-foreground">
        Imported the export from {result.manifest.exportedAt.slice(0, 10)}. The previous data was
        backed up to <span className="mono break-all text-foreground">{result.backupPath}</span>.
      </p>
      {clean && <Empty>Nothing needs attention.</Empty>}
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

/** Settings → Data: export everything but secrets to a zip, or replace all data with one. */
export function DataSection() {
  const [transcripts, setTranscripts] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<DataImportResult | null>(null);
  const input = useRef<HTMLInputElement>(null);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <SectionHeader title="Data" />
      <div className={cn(editorBody, "gap-6")}>
        <fieldset className="m-0 flex max-w-[720px] flex-col gap-4 border-none p-0">
          <legend className={sectionLegend}>Export</legend>
          <p className="m-0 text-meta text-muted-foreground">
            Downloads one zip with your settings, connections, repositories, agents, tags, backlog
            and tasks. Tokens are never exported, and repo checkouts and worktrees are not included.
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
            Replaces all data with an export, from this machine or another. Refused while tasks run,
            are queued or are finishing.
          </p>
          <input
            ref={input}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            aria-label="Export archive"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
          />
          <div>
            <Button variant="destructive" onClick={() => input.current?.click()}>
              Import data…
            </Button>
          </div>
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

      {file && (
        <ConfirmDialog
          title="Replace all blackwall data?"
          confirmLabel="Replace data"
          onConfirm={async () => setResult(await importData(file))}
          onClose={() => setFile(null)}
        >
          Every task, repository, connection, agent, tag and setting is replaced with the contents
          of <span className="mono break-all text-foreground">{file.name}</span>. The current data
          is backed up first. Tokens are not in the export: connections need theirs entered again
          unless this machine&apos;s keychain already has them.
        </ConfirmDialog>
      )}
    </div>
  );
}
