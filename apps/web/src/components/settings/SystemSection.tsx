import type { SystemInfo } from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { compactDatabase, getSystemInfo } from "../../api";
import { cn } from "../../lib/utils";
import { queryKeys, systemQuery, tasksQuery } from "../../query";
import { errorMessage } from "../../settings-forms";
import { FAST_GROWING_TABLE, formatBytes, formatUptime } from "../../system-info";
import { editorBody, sectionLegend } from "../classes";
import { ConfirmDialog } from "../ConfirmDialog";
import { RefreshButton } from "../RefreshButton";
import { Button } from "../ui/button";
import { ErrorText, fieldLabel } from "../ui/field";
import { CliStatusRows } from "./CliStatusList";
import { Empty, SectionHeader } from "./parts";

const fieldset = "m-0 flex max-w-[720px] flex-col gap-3 border-none p-0";

/** A label and its value, in the settings' two-column grid. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-3">
      <span className={fieldLabel}>{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function DataDirectory({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <fieldset className={fieldset}>
      <legend className={sectionLegend}>Data directory</legend>
      <div className="flex min-w-0 items-center gap-3">
        <span className="mono min-w-0 truncate text-foreground-strong" title={path}>
          {path}
        </span>
        <Button
          size="sm"
          onClick={() => void navigator.clipboard.writeText(path).then(() => setCopied(true))}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </fieldset>
  );
}

function Database({ database }: { database: SystemInfo["database"] }) {
  const files: [string, number][] = [
    ["blackwall.db", database.fileBytes],
    ["-wal", database.walBytes],
    ["-shm", database.shmBytes],
    ["total", database.totalBytes],
  ];
  return (
    <fieldset className={fieldset}>
      <legend className={sectionLegend}>Database</legend>
      <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-meta text-muted-foreground">
        {files.map(([name, bytes]) => (
          <span key={name}>
            <span className="mono">{name}</span>{" "}
            <span className="mono text-foreground-strong">{formatBytes(bytes)}</span>
          </span>
        ))}
      </p>
      <table className="w-full max-w-[520px] border-collapse text-meta">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-1 pr-3 font-normal">Table</th>
            <th className="py-1 pr-3 text-right font-normal">Rows</th>
            <th className="py-1 text-right font-normal">Size</th>
          </tr>
        </thead>
        <tbody>
          {database.tables.map((table) => {
            const fast = table.name === FAST_GROWING_TABLE;
            return (
              <tr
                key={table.name}
                className={cn(
                  "border-b border-border/50 align-top",
                  fast ? "text-foreground-strong" : "text-foreground",
                )}
              >
                <td className="py-1 pr-3">
                  <span className="mono">{table.name}</span>
                  {fast && (
                    <span className="block text-muted-foreground">
                      Grows fastest: one row per agent output event
                    </span>
                  )}
                </td>
                <td className="mono py-1 pr-3 text-right">{table.rows.toLocaleString()}</td>
                <td className="mono py-1 text-right">
                  {table.bytes === null ? "—" : formatBytes(table.bytes)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!database.dbstat && (
        <p className="m-0 text-meta text-muted-foreground">
          Per-table sizes unavailable in this SQLite build.
        </p>
      )}
    </fieldset>
  );
}

function Worktrees({ worktrees }: { worktrees: SystemInfo["worktrees"] }) {
  const queryClient = useQueryClient();
  const [calculating, setCalculating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function calculate() {
    setCalculating(true);
    setError(null);
    try {
      queryClient.setQueryData(queryKeys.system, await getSystemInfo(true));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCalculating(false);
    }
  }

  return (
    <fieldset className={fieldset}>
      <legend className={sectionLegend}>Worktrees and artifacts</legend>
      <Row label="Worktrees">
        <span className="mono text-foreground-strong">{worktrees.count}</span>
      </Row>
      <Row label="Artifacts">
        <span className="mono text-foreground-strong">
          {worktrees.artifactCount} · {formatBytes(worktrees.artifactBytes)}
        </span>
      </Row>
      <Row label="Total size">
        {worktrees.totalBytes !== null ? (
          <span className="mono text-foreground-strong">{formatBytes(worktrees.totalBytes)}</span>
        ) : (
          <>
            <Button size="sm" disabled={calculating} onClick={() => void calculate()}>
              {calculating ? "Calculating…" : "Calculate"}
            </Button>
            <span className="text-meta text-muted-foreground">
              Walks every worktree, node_modules included.
            </span>
          </>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </Row>
    </fieldset>
  );
}

function Runtime({ info }: { info: SystemInfo }) {
  const { runtime } = info;
  const { migrations } = info.database;
  return (
    <fieldset className={fieldset}>
      <legend className={sectionLegend}>Runtime</legend>
      <Row label="blackwall">
        <span className="mono text-foreground-strong">{runtime.version ?? "unknown"}</span>
      </Row>
      <Row label="Schema">
        <span className="mono text-foreground-strong">
          {migrations.applied}/{migrations.available}
        </span>
        {migrations.latest && (
          <span className="mono text-meta text-muted-foreground">{migrations.latest}</span>
        )}
        {migrations.applied < migrations.available && (
          <span className="text-meta text-muted-foreground">pending migrations</span>
        )}
      </Row>
      <Row label="Node">
        <span className="mono text-foreground-strong">{runtime.node}</span>
      </Row>
      <Row label="Platform">
        <span className="mono text-foreground-strong">
          {runtime.platform} {runtime.arch} ({runtime.osRelease})
        </span>
      </Row>
      <Row label="Uptime">
        <span className="mono text-foreground-strong">{formatUptime(runtime.uptimeSeconds)}</span>
      </Row>
    </fieldset>
  );
}

function Maintenance() {
  const queryClient = useQueryClient();
  const tasks = useQuery(tasksQuery);
  const [confirming, setConfirming] = useState(false);
  const [freed, setFreed] = useState<number | null>(null);
  const running = tasks.data?.some((task) => task.status === "running") ?? false;

  return (
    <fieldset className={fieldset}>
      <legend className={sectionLegend}>Maintenance</legend>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="default" disabled={running} onClick={() => setConfirming(true)}>
          Compact database
        </Button>
        <span className="text-meta text-muted-foreground">
          {freed !== null ? `Freed ${formatBytes(freed)}` : "Waits until no task is running."}
        </span>
      </div>
      {confirming && (
        <ConfirmDialog
          title="Compact the database?"
          confirmLabel="Compact"
          confirmVariant="default"
          onConfirm={async () => {
            const result = await compactDatabase();
            queryClient.setQueryData(queryKeys.system, result.info);
            setFreed(result.freedBytes);
          }}
          onClose={() => setConfirming(false)}
        >
          VACUUM rewrites the database file without its free pages. blackwall is blocked for a
          moment while it runs.
        </ConfirmDialog>
      )}
    </fieldset>
  );
}

/** What blackwall stores on disk and what it runs on, and compacting the database. */
export function SystemSection() {
  const system = useQuery(systemQuery);
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <SectionHeader title="System">
        <RefreshButton fetching={system.isFetching} onRefresh={() => void system.refetch()} />
      </SectionHeader>
      {system.error ? (
        <Empty>{system.error.message}</Empty>
      ) : !system.data ? (
        <Empty>Reading system status…</Empty>
      ) : (
        <div className={cn(editorBody, "gap-6")}>
          <DataDirectory path={system.data.dataDir} />
          <Database database={system.data.database} />
          <Worktrees worktrees={system.data.worktrees} />
          <Runtime info={system.data} />
          <fieldset className={fieldset}>
            <legend className={sectionLegend}>Agent CLIs</legend>
            <div className="max-w-[420px]">
              <CliStatusRows />
            </div>
          </fieldset>
          <Maintenance />
        </div>
      )}
    </div>
  );
}
