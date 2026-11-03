import type { CiCheck } from "@blackwall/shared";
import { CheckIcon, FailedIcon, SpinnerIcon } from "./icons";

const CHECK_ORDER: Record<CiCheck["state"], number> = {
  failed: 0,
  pending: 1,
  passed: 2,
  skipped: 3,
};

function CheckStateIcon({ state }: { state: CiCheck["state"] }) {
  switch (state) {
    case "pending":
      return <SpinnerIcon size="sm" className="animate-spin text-running" />;
    case "failed":
      return <FailedIcon size="sm" className="text-failed" />;
    case "passed":
      return <CheckIcon size="sm" className="text-done" />;
    case "skipped":
      return <CheckIcon size="sm" className="text-faint" />;
  }
}

function checkStateLabel(check: CiCheck): string {
  switch (check.state) {
    case "pending":
      return "running";
    case "failed":
      return check.conclusion?.replaceAll("_", " ") ?? "failed";
    case "passed":
      return "passed";
    case "skipped":
      return "skipped";
  }
}

/** A commit's checks, failing ones first, each with its state and link. Nothing when empty. */
export function CiChecksList({ checks }: { checks: readonly CiCheck[] }) {
  if (checks.length === 0) return null;
  const sorted = checks.toSorted((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]);
  return (
    <ul className="m-0 flex max-h-48 list-none flex-col gap-1 overflow-auto p-0">
      {sorted.map((check) => (
        <li key={`${check.kind}:${check.id}`} className="flex min-w-0 items-center gap-2 text-meta">
          <CheckStateIcon state={check.state} />
          {check.url ? (
            <a href={check.url} target="_blank" rel="noreferrer" className="truncate">
              {check.name}
            </a>
          ) : (
            <span className="truncate text-foreground">{check.name}</span>
          )}
          <span className="flex-1" />
          <span className="flex-none text-muted-foreground">{checkStateLabel(check)}</span>
        </li>
      ))}
    </ul>
  );
}
