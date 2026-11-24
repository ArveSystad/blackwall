import type { AgentCli, CliCheckResult } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { checkRepoCli } from "../../api";
import { CLI_NAMES, errorMessage } from "../../settings-forms";
import { StatusBadge } from "../StatusBadge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { ErrorText } from "../ui/field";

type CheckState =
  | { state: "pending"; prompt: boolean }
  | { state: "ok"; result: CliCheckResult }
  | { state: "error"; detail: string };

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Runs a CLI's check commands in the repo's folder with the environment as
 * typed (saved or not) and shows each step's output; Send test prompt also
 * runs one short read-only request on that account.
 */
export function CliCheckDialog({
  repoId,
  cli,
  env,
  onClose,
}: {
  repoId: string;
  cli: AgentCli;
  env: Record<string, string>;
  onClose: () => void;
}) {
  // The variables as typed when the dialog opened; the form behind it can't change meanwhile.
  const [checked] = useState(env);
  // Each run is its own query, so Run again and Send test prompt always ask the server afresh.
  const [attempt, setAttempt] = useState({ n: 0, prompt: false });
  const query = useQuery({
    queryKey: ["cli-check", repoId, cli, checked, attempt],
    queryFn: () => checkRepoCli(repoId, { cli, env: checked, prompt: attempt.prompt }),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const check: CheckState = query.isFetching
    ? { state: "pending", prompt: attempt.prompt }
    : query.data
      ? { state: "ok", result: query.data }
      : { state: "error", detail: errorMessage(query.error) };
  const run = (prompt: boolean) => setAttempt((a) => ({ n: a.n + 1, prompt }));

  const pending = check.state === "pending";
  const names = Object.keys(checked);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[720px]">
        <div className="flex flex-col gap-3.5 px-5 pt-[18px] pb-[18px]">
          <DialogTitle>Test {CLI_NAMES[cli]} environment</DialogTitle>
          <DialogDescription className="m-0 text-pretty">
            Runs {CLI_NAMES[cli]} in this repo&apos;s folder with{" "}
            {names.length > 0 ? (
              <>
                {names.map((name, i) => (
                  <span key={name}>
                    {i > 0 && ", "}
                    <span className="mono text-foreground-strong">{name}</span>
                  </span>
                ))}{" "}
                as typed, saved or not.
              </>
            ) : (
              "no extra variables."
            )}
            {cli === "copilot" &&
              " Copilot can't report its account without a session; send a test prompt to prove the login."}
          </DialogDescription>
          {check.state === "pending" && (
            <p className="m-0 text-meta text-muted-foreground" role="status">
              {check.prompt ? "Sending the test prompt…" : "Running checks…"}
            </p>
          )}
          {check.state === "error" && <ErrorText>{check.detail}</ErrorText>}
          {check.state === "ok" && (
            <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Check steps">
              {check.result.steps.map((step) => (
                <li key={step.label} className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <StatusBadge
                      status={step.ok ? "done" : "failed"}
                      label={step.ok ? "OK" : "Failed"}
                    />
                    <span className="font-medium text-foreground-strong">{step.label}</span>
                    <span className="mono min-w-0 flex-1 truncate text-muted-foreground">
                      {step.command}
                    </span>
                    <span className="text-meta text-faint">{seconds(step.durationMs)}</span>
                  </div>
                  <pre className="mono m-0 max-h-48 overflow-auto bg-card px-3 py-2 text-meta whitespace-pre-wrap text-foreground">
                    {step.output ||
                      (step.exitCode === null
                        ? "No output"
                        : `Exit code ${step.exitCode}, no output`)}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <span className="mr-auto text-meta text-muted-foreground">
            Runs one short read-only request on this account; uses a little quota.
          </span>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button disabled={pending} onClick={() => run(false)}>
            Run again
          </Button>
          <Button variant="primary" disabled={pending} onClick={() => run(true)}>
            Send test prompt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
