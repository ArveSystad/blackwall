import {
  AGENT_CLIS,
  AGENT_TRUST_LEVELS,
  TRUST_FORCED_REASONS,
  type AgentCli,
} from "@blackwall/shared";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { CLI_NAMES } from "../../settings-forms";
import {
  ALWAYS_DENIED_NOTE,
  FORCED_LOCKED_HELP,
  FORCED_LOCKED_NOTES,
  TRUST_MATRIX,
  TRUST_NAMES,
  TRUST_PROFILE_NOTE,
  TRUST_PROFILES,
  alwaysDeniedCommands,
  trustDetail,
  type TrustCell,
} from "../../trust";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { fieldLabel } from "../ui/field";
import { Kbd } from "../ui/kbd";

const list = "m-0 flex list-none flex-col gap-0.5 p-0";

function Section({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className={cn(fieldLabel, "m-0", className)}>{title}</h3>
      {children}
    </section>
  );
}

/** One CLI per line: `<CLI>: <text>`. */
function PerCliList({ record }: { record: Record<AgentCli, string> }) {
  return (
    <ul className={cn(list, "pl-3")}>
      {AGENT_CLIS.map((cli) => (
        <li key={cli}>
          <span className="text-faint">{CLI_NAMES[cli]}:</span> {record[cli]}
        </li>
      ))}
    </ul>
  );
}

function Cell({ cell }: { cell: TrustCell }) {
  if (typeof cell === "string") return <>{cell}</>;
  return (
    <span className="flex flex-col gap-0.5">
      <span>
        <span className="text-faint">Read-only</span> {cell.readOnly}
      </span>
      <span>
        <span className="text-faint">Implement</span> {cell.implement}
      </span>
    </span>
  );
}

/** What each agent trust level allows, opened from the `?` beside Agent trust. */
export function TrustHelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-[720px]">
        <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-5 pt-[18px] pb-4">
          <div className="flex flex-col gap-2">
            <DialogTitle>Agent trust levels</DialogTitle>
            <DialogDescription className="m-0 text-pretty">
              What agents can do at each level. Trust is set per repo and applies when you save.
            </DialogDescription>
          </div>

          <Section title="Profiles">
            <div className="flex flex-col gap-1.5 text-meta text-muted-foreground">
              {TRUST_PROFILES.map((profile) => (
                <div key={profile.name} className="flex flex-col gap-0.5">
                  <p className="m-0">
                    <span className="text-foreground-strong">{profile.name}:</span> {profile.detail}
                  </p>
                  <span className="pl-3">{profile.subagentsLabel}:</span>
                  <PerCliList record={profile.subagents} />
                </div>
              ))}
              <p className="m-0">{TRUST_PROFILE_NOTE}</p>
            </div>
          </Section>

          {AGENT_TRUST_LEVELS.map((level) => (
            <Section
              key={level}
              title={TRUST_NAMES[level]}
              className={cn(level === "unrestricted" && "text-failed")}
            >
              <ul className={cn(list, "text-meta text-muted-foreground")}>
                {trustDetail(level).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Section>
          ))}

          <table className="w-full border-collapse text-meta">
            <caption className="sr-only">What each trust level allows</caption>
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-normal">
                  Capability
                </th>
                {AGENT_TRUST_LEVELS.map((level) => (
                  <th
                    key={level}
                    scope="col"
                    className={cn(
                      "py-1 pr-3 font-normal last:pr-0",
                      level === "unrestricted" && "text-failed",
                    )}
                  >
                    {TRUST_NAMES[level]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TRUST_MATRIX.map((row) => (
                <tr key={row.capability} className="border-b border-border/50 align-top">
                  <th
                    scope="row"
                    className="py-1 pr-3 text-left font-normal text-foreground-strong"
                  >
                    {row.capability}
                  </th>
                  {AGENT_TRUST_LEVELS.map((level) => (
                    <td key={level} className="py-1 pr-3 text-foreground last:pr-0">
                      <Cell cell={row.cells[level]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          <Section title="Always denied under Locked and Trusted">
            <ul className={cn(list, "mono flex-row flex-wrap gap-x-3 text-meta text-foreground")}>
              {alwaysDeniedCommands().map((command) => (
                <li key={command}>{command}</li>
              ))}
            </ul>
            <p className="m-0 text-meta text-muted-foreground">{ALWAYS_DENIED_NOTE}</p>
          </Section>

          <Section title="When trust is forced to Locked">
            <ul className={cn(list, "text-meta text-muted-foreground")}>
              {TRUST_FORCED_REASONS.map((reason) => (
                <li key={reason}>{FORCED_LOCKED_HELP[reason]}</li>
              ))}
              {FORCED_LOCKED_NOTES.map((note) => (
                <li key={note} className="text-faint">
                  {note}
                </li>
              ))}
            </ul>
          </Section>
        </div>
        <DialogFooter>
          <Button variant="primary" autoFocus onClick={onClose}>
            Close
            <Kbd onFill aria-hidden="true">
              Esc
            </Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
