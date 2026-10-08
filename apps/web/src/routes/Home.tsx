import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CheckIcon, WallIcon } from "../components/icons";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { connectionsQuery, reposQuery, tasksQuery } from "../query";

function SetupStep({
  number,
  title,
  done,
  current,
  children,
  action,
}: {
  number: number;
  title: string;
  done: boolean;
  current: boolean;
  children: ReactNode;
  action: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-3.5 rounded-lg border border-border bg-sidebar px-4 py-3.5",
        current && "border-cyan shadow-glow-cyan",
        !done && !current && "opacity-60",
      )}
    >
      <span
        className={cn(
          "mono inline-flex size-6 flex-none items-center justify-center rounded-full border border-border-strong text-label text-muted-foreground",
          current && "border-cyan text-cyan",
          done && "border-done text-done",
        )}
      >
        {done ? <CheckIcon size="sm" /> : number}
        <span className="sr-only">{done ? " (done)" : ""}</span>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold text-foreground-strong">{title}</span>
        <span className="text-[12.5px] text-muted-foreground">{children}</span>
      </div>
      {action}
    </li>
  );
}

/** First run: what to set up before the first task. */
function FirstRun() {
  const connections = useQuery(connectionsQuery);
  const repos = useQuery(reposQuery);
  const hasConnection = (connections.data ?? []).some((c) => c.hasToken);
  const hasRepo = (repos.data ?? []).length > 0;
  const current = !hasConnection ? 1 : !hasRepo ? 2 : 3;

  return (
    <div className="flex w-full max-w-[600px] flex-col gap-[22px]">
      <div className="flex flex-col gap-2">
        <span className="label text-cyan">First run</span>
        <h1 className="m-0 font-display text-[28px] leading-[34px] font-semibold tracking-[0.01em] text-foreground-strong">
          Agents work inside. Nothing crosses the wall without you.
        </h1>
        <p className="m-0 text-muted-foreground">
          Two things before the first task: somewhere to read work from, and a repo to work in.
        </p>
      </div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        <SetupStep
          number={1}
          title="Add a connection"
          done={hasConnection}
          current={current === 1}
          action={
            <Button variant={current === 1 ? "primary" : "default"} asChild>
              <Link to="/settings/$section" params={{ section: "connections" }}>
                {hasConnection ? "Manage connections" : "Add connection"}
              </Link>
            </Button>
          }
        >
          GitHub.com, a GitHub Enterprise host, or Jira Cloud. Tokens stay on this machine.
        </SetupStep>
        <SetupStep
          number={2}
          title="Register a repository"
          done={hasRepo}
          current={current === 2}
          action={
            <Button variant={current === 2 ? "primary" : "default"} asChild>
              <Link to="/settings/$section" params={{ section: "repositories" }}>
                {hasRepo ? "Manage repos" : "Add repo"}
              </Link>
            </Button>
          }
        >
          Point at a local clone, or scan a folder like <span className="mono">~/code</span> and
          pick from what is found.
        </SetupStep>
        <SetupStep
          number={3}
          title="Start a task"
          done={false}
          current={current === 3}
          action={null}
        >
          From a Jira key, a PR URL, or a plain prompt.
        </SetupStep>
      </ol>
      <p className="m-0 text-meta text-muted-foreground">
        The agent library ships with defaults; tune them in{" "}
        <Link to="/settings/$section" params={{ section: "agents" }}>
          Settings
        </Link>
        .
      </p>
    </div>
  );
}

/** Main pane with no task selected: first-run setup, or a prompt to pick a task. */
export function Home() {
  const tasks = useQuery(tasksQuery);
  return (
    <div className="flex h-full items-center justify-center overflow-auto px-6 py-10">
      {tasks.data?.length === 0 ? (
        <FirstRun />
      ) : (
        <div className="flex flex-col items-center gap-2 text-center">
          <WallIcon className="size-7 text-faint" />
          <span className="font-medium text-foreground-strong">No task selected</span>
          <span className="text-meta text-muted-foreground">
            Pick a task from the inbox to see its progress.
          </span>
        </div>
      )}
    </div>
  );
}
