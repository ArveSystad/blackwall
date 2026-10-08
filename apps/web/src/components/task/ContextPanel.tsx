import { AGENT_ROLES, type AgentRole, type Task } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { agentsQuery, reposQuery } from "../../query";
import { ROLE_LABELS } from "../../settings-forms";
import { AgentTile } from "../AgentTile";

const TRIAGE_LABELS = {
  intervene: "Run and let me intervene",
  pause: "Pause each review round",
} as const;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-3 py-1.5">
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  );
}

function roleIds(task: Task, role: AgentRole): string[] {
  const value = task.agents[role];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** What the task started from: its text, origin, workspace, agents and triage mode. */
export function ContextPanel({ task }: { task: Task }) {
  const repos = useQuery(reposQuery);
  const agents = useQuery(agentsQuery);
  const repo = repos.data?.find((r) => r.id === task.repoId);
  const agentMap = new Map((agents.data ?? []).map((a) => [a.id, a]));

  return (
    <div className="flex max-w-3xl flex-col gap-5 px-5 py-4">
      <section className="flex flex-col gap-1.5">
        <h2 className="label m-0 text-muted-foreground">Context</h2>
        {task.freeText.trim() ? (
          <p className="m-0 whitespace-pre-wrap text-foreground">{task.freeText}</p>
        ) : (
          <p className="m-0 text-muted-foreground">
            No extra context. The planner works from the{" "}
            {task.origin.kind === "jira-issue" ? "Jira issue" : "pull request"}.
          </p>
        )}
      </section>
      <section className="flex flex-col">
        <h2 className="label m-0 mb-1 text-muted-foreground">Workspace</h2>
        <dl className="m-0">
          <Field label="Repository">
            {repo ? (
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="mono text-foreground-strong">{repo.name}</span>
                <span className="mono text-[11.5px] text-faint">{repo.path}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">Unknown repo</span>
            )}
          </Field>
          <Field label="Branch">
            <span className="mono">{task.branch ?? "created when the task starts"}</span>
          </Field>
          <Field label="Worktree">
            <span className="mono break-all">
              {task.worktreePath ?? "created when the task starts"}
            </span>
          </Field>
          {task.mode !== "review" && <Field label="Triage">{TRIAGE_LABELS[task.triageMode]}</Field>}
        </dl>
      </section>
      <section className="flex flex-col">
        <h2 className="label m-0 mb-1 text-muted-foreground">Agents</h2>
        <dl className="m-0">
          {AGENT_ROLES.map((role) => {
            const ids = roleIds(task, role);
            return (
              <Field key={role} label={ROLE_LABELS[role]}>
                {ids.length === 0 ? (
                  <span className="text-faint">None</span>
                ) : (
                  <span className="flex flex-wrap gap-x-3 gap-y-1">
                    {ids.map((id) => {
                      const agent = agentMap.get(id);
                      return (
                        <span key={id} className="inline-flex items-center gap-1.5">
                          {agent && <AgentTile cli={agent.cli} />}
                          {agent?.name ?? "Deleted agent"}
                          {agent?.model && (
                            <span className="mono text-[11px] text-faint">{agent.model}</span>
                          )}
                        </span>
                      );
                    })}
                  </span>
                )}
              </Field>
            );
          })}
        </dl>
      </section>
    </div>
  );
}
