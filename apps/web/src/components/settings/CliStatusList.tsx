import type { CliStatus } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { clisQuery } from "../../query";
import { CLI_NAMES } from "../../settings-forms";
import { AgentTile } from "../AgentTile";
import { CheckIcon, WarnIcon } from "../icons";
import { ErrorText } from "../ui/field";

function CliRow({ status }: { status: CliStatus }) {
  return (
    <li className="flex items-center gap-2 py-1">
      <AgentTile cli={status.cli} />
      <span className="truncate text-foreground-strong">{CLI_NAMES[status.cli]}</span>
      <span className="flex-1" />
      {status.installed ? (
        <span className="inline-flex items-center gap-1.5 text-meta text-done">
          <CheckIcon size="sm" />
          <span className="mono">{status.version ?? "unknown version"}</span>
        </span>
      ) : (
        <span
          className="inline-flex items-center gap-1.5 text-meta text-failed"
          title={status.error ?? undefined}
        >
          <WarnIcon size="sm" />
          Not installed
        </span>
      )}
    </li>
  );
}

/** Which agent CLIs the server found on PATH at startup, and their versions. */
export function CliStatusList() {
  const clis = useQuery(clisQuery);
  return (
    <section aria-label="Agent CLIs" className="mt-auto border-t border-border px-3.5 py-2.5">
      <h2 className="label m-0 mb-1 text-muted-foreground">Agent CLIs</h2>
      {clis.isPending ? (
        <p className="m-0 py-1 text-meta text-muted-foreground">Checking installed CLIs…</p>
      ) : clis.isError ? (
        <ErrorText className="py-1">{clis.error.message}</ErrorText>
      ) : (
        <>
          <ul className="m-0 list-none p-0">
            {clis.data.map((status) => (
              <CliRow key={status.cli} status={status} />
            ))}
          </ul>
          {clis.data.some((status) => !status.installed) && (
            <p className="m-0 pt-1 text-meta text-muted-foreground">
              Agents on a missing CLI cannot run. Install it, log in, then restart blackwall.
            </p>
          )}
        </>
      )}
    </section>
  );
}
