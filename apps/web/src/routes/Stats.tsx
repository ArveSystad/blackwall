import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import { GridBackdrop } from "../components/GridBackdrop";
import { BackIcon, RepoIcon, WallIcon } from "../components/icons";
import { ORIGINS } from "../components/origins";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { useEscapeTo } from "../keyboard";
import { cn } from "../lib/utils";
import { doneTimesQuery, reposQuery, tasksQuery, usageQuery } from "../query";
import {
  dayLabel,
  shortDayLabel,
  STATS_DAYS,
  TASK_TYPES,
  taskStats,
  usageStats,
  type TaskStats,
} from "../stats";
import { formatCost, formatTokens, usageTitle, type UsageTotal } from "../usage";

function Message({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <WallIcon className="size-7 text-faint" />
      <div className="font-medium text-foreground-strong">{title}</div>
      {children && <div className="max-w-80 text-meta text-muted-foreground">{children}</div>}
    </div>
  );
}

function Tile({
  icon,
  label,
  value,
  children,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-4 py-3">
      <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="mono text-[28px] leading-[34px] font-semibold text-foreground-strong">
        {value}
      </span>
      {children}
    </div>
  );
}

/** Resolved tasks per local day; each bar grows in once when its day first mounts. */
function PerDayChart({ perDay, now }: { perDay: NonNullable<TaskStats["perDay"]>; now: Date }) {
  const most = Math.max(1, ...perDay.map((d) => d.count));
  return (
    <ol
      aria-label={`Tasks resolved per day, last ${STATS_DAYS} days`}
      className="m-0 flex list-none items-end gap-1.5 p-0"
    >
      {perDay.map((day) => (
        // Keyed by date, so live updates only change the height and a new day animates in.
        <li key={day.date.toISOString()} className="flex min-w-0 flex-1 flex-col items-center">
          <span className="sr-only">{dayLabel(day.date, now, day.count)}</span>
          <div aria-hidden="true" className="flex w-full flex-col items-center gap-1.5">
            <span
              className={cn(
                "mono text-meta",
                day.count > 0 ? "text-foreground-strong" : "text-faint",
              )}
            >
              {day.count}
            </span>
            <div className="flex h-40 w-full items-end">
              <div
                className={cn(
                  "w-full origin-bottom animate-bar-grow rounded-sm",
                  day.count > 0 ? "bg-done shadow-glow-done" : "bg-border-strong",
                )}
                style={{ height: `max(${(day.count / most) * 100}%, 2px)` }}
              />
            </div>
            <span className="mono text-label whitespace-nowrap text-muted-foreground">
              {shortDayLabel(day.date, now)}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Usage rows: a label, then tokens and cost, with the breakdown as the tooltip. */
function UsageList({
  label,
  rows,
}: {
  label: string;
  rows: { key: string; name: string; total: UsageTotal }[];
}) {
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col gap-1 p-0">
      {rows.map((row) => (
        <li
          key={row.key}
          title={usageTitle(row.total)}
          className="flex items-baseline gap-3 rounded-md border border-border bg-card px-3 py-1.5"
        >
          <span className="min-w-0 flex-1 truncate text-meta text-foreground">{row.name}</span>
          <span
            className={cn(
              "mono text-meta",
              row.total.tokens > 0 ? "text-foreground-strong" : "text-faint",
            )}
          >
            {formatTokens(row.total.tokens)} tokens
          </span>
          <span className="mono w-20 text-right text-meta text-muted-foreground">
            {formatCost(row.total)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Stats replaces both panes: how many tasks were resolved, of which types,
 * across how many repos, and per day over the last {@link STATS_DAYS} days;
 * then the tokens and cost the agents used per day and per repo.
 */
export function Stats() {
  const navigate = useNavigate();
  const tasks = useQuery(tasksQuery);
  const doneTimes = useQuery(doneTimesQuery);
  const repos = useQuery(reposQuery);
  const usage = useQuery(usageQuery);
  // Recounted whenever a live event changes the tasks, done times or usage.
  const { now, stats, used } = useMemo(() => {
    const now = new Date();
    return {
      now,
      stats: tasks.data && taskStats(tasks.data, doneTimes.data, now),
      used: tasks.data && usage.data && usageStats(usage.data, tasks.data, now),
    };
  }, [tasks.data, doneTimes.data, usage.data]);
  const repoName = (id: string) => repos.data?.find((r) => r.id === id)?.name ?? id;

  useEscapeTo(() => void navigate({ to: "/" }));

  return (
    <div className="relative isolate flex h-full flex-col overflow-hidden">
      <GridBackdrop />
      <div className="relative z-10 w-[352px] shrink-0 px-2.5 pt-3">
        <Button variant="ghost" size="sm" className="mb-2 justify-start" asChild>
          <Link to="/">
            <BackIcon size="sm" />
            Inbox
            <span className="flex-1" />
            <Kbd>Esc</Kbd>
          </Link>
        </Button>
      </div>

      {/* Scrolls on its own, so the backdrop and header stay put. */}
      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        {/* Kept within the grid mask's faded band (styles.css `.bw-grid`). */}
        <div className="mx-auto flex w-full max-w-[520px] flex-col gap-6">
          <h1 className="m-0 text-title font-semibold text-foreground-strong">Stats</h1>
          {tasks.isPending ? (
            <Message title="Tallying stats…" />
          ) : tasks.isError ? (
            <Message title="Could not load stats">
              {tasks.error.message}{" "}
              <Button variant="ghost" size="sm" onClick={() => void tasks.refetch()}>
                Retry
              </Button>
            </Message>
          ) : (
            stats && (
              <>
                <section aria-label="Tasks resolved" className="flex flex-col gap-1">
                  <span className="label text-muted-foreground">Tasks resolved</span>
                  <span className="mono text-[64px] leading-[72px] font-semibold text-done text-shadow-glow-done">
                    {stats.resolved}
                  </span>
                  {stats.resolved === 0 && (
                    <span className="text-meta text-muted-foreground">
                      Log empty. No tasks resolved yet
                    </span>
                  )}
                </section>

                <section aria-label="By type" className="grid grid-cols-2 gap-3">
                  {TASK_TYPES.map((type) => {
                    const Icon = ORIGINS.find((o) => o.value === type.origin)!.icon;
                    return (
                      <Tile
                        key={type.key}
                        icon={<Icon />}
                        label={type.label}
                        value={stats.byType[type.key]}
                      />
                    );
                  })}
                  <Tile icon={<RepoIcon />} label="Repositories touched" value={stats.repos}>
                    {repos.data && (
                      <span className="text-meta text-muted-foreground">
                        of {repos.data.length} registered
                      </span>
                    )}
                  </Tile>
                </section>

                <section className="flex flex-col gap-3">
                  <h2 className="label m-0 text-muted-foreground">
                    Resolved per day · last {STATS_DAYS} days
                  </h2>
                  {doneTimes.isPending ? (
                    <Message title="Plotting the timeline…" />
                  ) : doneTimes.isError ? (
                    <Message title="Could not load resolve times">
                      {doneTimes.error.message}{" "}
                      <Button variant="ghost" size="sm" onClick={() => void doneTimes.refetch()}>
                        Retry
                      </Button>
                    </Message>
                  ) : (
                    stats.perDay && <PerDayChart perDay={stats.perDay} now={now} />
                  )}
                </section>

                <section className="flex flex-col gap-3">
                  <h2 className="label m-0 text-muted-foreground">
                    Usage per day · last {STATS_DAYS} days
                  </h2>
                  {usage.isPending ? (
                    <Message title="Reading usage meters…" />
                  ) : usage.isError ? (
                    <Message title="Could not load usage">
                      {usage.error.message}{" "}
                      <Button variant="ghost" size="sm" onClick={() => void usage.refetch()}>
                        Retry
                      </Button>
                    </Message>
                  ) : (
                    used && (
                      <UsageList
                        label={`Usage per day, last ${STATS_DAYS} days`}
                        rows={used.perDay.map((day) => ({
                          key: day.date.toISOString(),
                          name: shortDayLabel(day.date, now),
                          total: day.total,
                        }))}
                      />
                    )
                  )}
                </section>

                {used && (
                  <section className="flex flex-col gap-3">
                    <h2 className="label m-0 text-muted-foreground">Usage per repo</h2>
                    {used.perRepo.length === 0 ? (
                      <span className="text-meta text-muted-foreground">
                        Meters at zero. No usage recorded yet
                      </span>
                    ) : (
                      <UsageList
                        label="Usage per repo"
                        rows={used.perRepo.map((repo) => ({
                          key: repo.repoId,
                          name: repoName(repo.repoId),
                          total: repo.total,
                        }))}
                      />
                    )}
                  </section>
                )}
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}
