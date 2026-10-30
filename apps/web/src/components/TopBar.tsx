import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { pendingCount, repoStatusLine } from "../backlog";
import { backlogQuery, backlogRunnerQuery, reposQuery, settingsQuery, tasksQuery } from "../query";
import { modKeyLabel } from "../keyboard";
import { openSearch } from "../search-palette";
import {
  resolveSelectedRepo,
  selectRepo,
  setSelectedRepo,
  useSelectedRepoId,
} from "../selected-repo";
import { isSettingsPath } from "../settings-shutter";
import { ChatToggle } from "./ChatToggle";
import { BacklogIcon, GearIcon, SearchIcon, StatsIcon } from "./icons";
import { PushToTalk } from "./PushToTalk";
import { QuotaChip } from "./QuotaChip";
import { RepoMenuItems } from "./RepoMenuItems";
import { RunProjectButton } from "./RunProjectButton";
import { ThemeToggle } from "./ThemeToggle";
import { Button } from "./ui/button";
import {
  SelectMenu,
  SelectMenuContent,
  SelectMenuItem,
  SelectMenuSeparator,
  SelectMenuTrigger,
} from "./ui/select-menu";
import { Wordmark } from "./Wordmark";

/** Item value for "No repo": Radix Select forbids an empty one, and repo ids are UUIDs. */
const NO_REPO = "none";

const ACTIVE_ICON =
  "shrink-0 data-[status=active]:bg-muted data-[status=active]:text-foreground-strong data-[status=active]:[--bw-chamfer-line:var(--border-strong)]";

/**
 * Global top bar: wordmark, the repo to work in with its backlog status, and app-wide buttons.
 * Each repo in the picker shows how many items wait in its backlog; the status line tells how many
 * of the selected repo's tasks run and whether auto-start is on.
 */
export function TopBar() {
  const navigate = useNavigate();
  const repos = useQuery(reposQuery);
  const usable = (repos.data ?? []).filter((r) => r.exists);
  const backlogs = useQueries({ queries: usable.map((r) => backlogQuery(r.id)) });
  const repo = resolveSelectedRepo(useSelectedRepoId(), repos.data);
  const tasks = useQuery(tasksQuery);
  const settings = useQuery(settingsQuery);
  const runner = useQuery({ ...backlogRunnerQuery(repo?.id ?? ""), enabled: !!repo });
  const inSettings = useRouterState({ select: (s) => isSettingsPath(s.location.pathname) });

  const repoTasks = repo ? (tasks.data ?? []).filter((t) => t.repoId === repo.id) : [];
  const status =
    repo && tasks.data && settings.data && runner.data
      ? repoStatusLine({ settings: settings.data, runner: runner.data, tasks: repoTasks })
      : null;

  const pick = (id: string) => {
    if (id === NO_REPO) {
      setSelectedRepo(null);
      return;
    }
    selectRepo(navigate, id);
  };

  return (
    <header
      aria-label="Top bar"
      className="flex h-11 flex-none items-center border-b border-border bg-sidebar text-body"
    >
      {/* As wide as the inbox column, so the wordmark sits where it would over the inbox. */}
      <div className="flex h-full w-[352px] shrink-0 items-center pl-3.5">
        <WordmarkLink />
      </div>
      <div
        role="region"
        aria-label="Repo context"
        className="flex min-w-0 flex-1 items-center gap-3 pl-5"
      >
        <span className="label text-foreground">Repo</span>
        <SelectMenu value={repo?.id ?? NO_REPO} onValueChange={pick}>
          <SelectMenuTrigger
            aria-label="Selected repo"
            className="mono h-7 w-auto max-w-[260px] shrink-0 text-[12.5px]"
          />
          <SelectMenuContent>
            <SelectMenuItem value={NO_REPO}>No repo</SelectMenuItem>
            {usable.length > 0 && <SelectMenuSeparator />}
            <RepoMenuItems
              repos={usable}
              trailing={(r) => {
                const items = backlogs[usable.indexOf(r)]?.data;
                return (
                  items && <span className="mono text-faint">{pendingCount(items)} waiting</span>
                );
              }}
            />
          </SelectMenuContent>
        </SelectMenu>
        {repo ? (
          <>
            <Button variant="ghost" size="sm" className="shrink-0" asChild>
              <Link to="/repos/$repoId/backlog" params={{ repoId: repo.id }}>
                <BacklogIcon size="sm" />
                View backlog
              </Link>
            </Button>
            <RunProjectButton repo={repo} className="shrink-0" />
            {/* The path's zero basis makes it collapse before the status line starts to truncate. */}
            {status && (
              <span className="min-w-0 truncate whitespace-nowrap text-foreground" title={status}>
                {status}
              </span>
            )}
            <span
              className="mono min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground"
              title={repo.path}
            >
              {repo.path}
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-foreground">Pick a repo to work in</span>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 pr-3 pl-3">
        {/* At the widest the quota chip clips, never the buttons. */}
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <QuotaChip />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label="Search"
          aria-keyshortcuts="Control+K Meta+K"
          title={`Search (${modKeyLabel("K")})`}
          onClick={openSearch}
        >
          <SearchIcon />
        </Button>
        <PushToTalk className="shrink-0" />
        <ChatToggle className="shrink-0" />
        <ThemeToggle className="shrink-0" />
        <Button variant="ghost" size="icon" className={ACTIVE_ICON} asChild>
          <Link to="/stats" aria-label="Stats" title="Stats">
            <StatsIcon />
          </Link>
        </Button>
        <Button variant="ghost" size="icon" className={ACTIVE_ICON} asChild>
          {/* Straight to a section, so the shutter's open has no redirect hop; lit on every section. */}
          <Link
            to="/settings/$section"
            params={{ section: "connections" }}
            data-status={inSettings ? "active" : undefined}
            aria-label="Settings"
            title="Settings"
          >
            <GearIcon />
          </Link>
        </Button>
      </div>
    </header>
  );
}

function WordmarkLink() {
  return (
    <Link
      to="/"
      aria-label="blackwall inbox"
      activeOptions={{ exact: true }}
      className="flex shrink-0 items-center no-underline hover:no-underline"
    >
      <Wordmark />
    </Link>
  );
}
