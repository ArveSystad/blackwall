import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  notFound,
  redirect,
} from "@tanstack/react-router";
import { ArchiveLaunchesProvider } from "./components/ArchiveLaunchesProvider";
import { ChatPanel } from "./components/ChatPanel";
import { GridLayout, GridWindow } from "./components/GridLayout";
import { Inbox } from "./components/Inbox";
import { NotFound } from "./components/NotFound";
import { SearchPalette } from "./components/SearchPalette";
import { SkylineProvider } from "./components/SkylineProvider";
import { SettingsShutter } from "./components/SettingsShutter";
import { TopBar } from "./components/TopBar";
import { useVoiceActions } from "./components/use-voice-actions";
import { VoiceTaskModal } from "./components/VoiceTaskModal";
import { Home } from "./routes/Home";
import { prefersReducedMotion } from "./reduced-motion";
import { routeTransitionTypes, supportsRouteTransition } from "./route-transition";
import { Settings } from "./settings-chunk";
import { isSettingsSection } from "./settings-sections";
import { isSettingsPath } from "./settings-shutter";
import { useChatHotkey } from "./chat";
import { useSearchHotkey } from "./search-palette";
import { useSystemThemeSync, useThemeHotkey } from "./theme";
import { recordWindowOrigin } from "./window-origin";

// Heavier routes load as their own chunks. The wrapped ones get a `loader` that preloads the
// chunk, since the router only preloads a route's own `component` on hover.
const TaskView = lazyRouteComponent(() => import("./routes/TaskView"), "TaskView");
const Backlog = lazyRouteComponent(() => import("./routes/Backlog"), "Backlog");
const CodeView = lazyRouteComponent(() => import("./routes/CodeView"), "CodeView");
const MyPullRequests = lazyRouteComponent(
  () => import("./routes/MyPullRequests"),
  "MyPullRequests",
);

const rootRoute = createRootRoute({
  component: function Root() {
    // App-wide shortcuts that must work on every route, Settings included.
    useThemeHotkey();
    useSystemThemeSync();
    useChatHotkey();
    useSearchHotkey();
    useVoiceActions();
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="bw-titlebar" aria-hidden />
        <TopBar />
        {/* The chat stays open beside every page: the shell, Settings and Stats. */}
        <div className="flex min-h-0 flex-1">
          {/* Settings slides down over the outlet as a shutter, under the TopBar and beside the chat. */}
          <div className="relative min-h-0 min-w-0 flex-1 [view-transition-name:bw-route]">
            <Outlet />
            <SettingsShutter />
          </div>
          <ChatPanel />
        </div>
        <SearchPalette />
        <VoiceTaskModal />
      </div>
    );
  },
  notFoundComponent: NotFound,
});

/** Two-pane shell: the inbox on the left, the grid (Home and its windows) on the right. */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: () => (
    <ArchiveLaunchesProvider>
      <SkylineProvider>
        <div className="flex h-full min-w-0">
          <Inbox />
          <main className="flex h-full min-w-0 flex-1 flex-col bg-background">
            <div className="min-h-0 flex-1">
              <Outlet />
            </div>
          </main>
        </div>
      </SkylineProvider>
    </ArchiveLaunchesProvider>
  ),
});

/** The grid behind Home and every window over it; it stays mounted between them. */
const gridRoute = createRoute({
  getParentRoute: () => shellRoute,
  id: "grid",
  component: GridLayout,
});

/**
 * The window the task, Backlog, Code, review requests, assigned issues, my pull requests and
 * active agents views float in over the grid. New grid screens go here.
 */
const windowRoute = createRoute({
  getParentRoute: () => gridRoute,
  id: "window",
  component: GridWindow,
});

const homeRoute = createRoute({
  getParentRoute: () => gridRoute,
  path: "/",
  component: Home,
});

const taskRoute = createRoute({
  getParentRoute: () => windowRoute,
  path: "/tasks/$taskId",
  loader: () => TaskView.preload?.(),
  component: function TaskRoute() {
    const { taskId } = taskRoute.useParams();
    // Keyed so switching tasks starts from a fresh view.
    return <TaskView key={taskId} taskId={taskId} />;
  },
});

const backlogRoute = createRoute({
  getParentRoute: () => windowRoute,
  path: "/repos/$repoId/backlog",
  /** `item`: a backlog item to open in the editor, from the search palette; cleared once read. */
  validateSearch: (search: Record<string, unknown>): { item?: string } =>
    typeof search.item === "string" ? { item: search.item } : {},
  loader: () => Backlog.preload?.(),
  component: function BacklogRoute() {
    const { repoId } = backlogRoute.useParams();
    const { item } = backlogRoute.useSearch();
    return <Backlog key={repoId} repoId={repoId} openItemId={item} />;
  },
});

const codeRoute = createRoute({
  getParentRoute: () => windowRoute,
  path: "/repos/$repoId/code",
  /** `file`: the repo-relative path of the file on screen. */
  validateSearch: (search: Record<string, unknown>): { file?: string } =>
    typeof search.file === "string" ? { file: search.file } : {},
  loader: () => CodeView.preload?.(),
  component: function CodeRoute() {
    const { repoId } = codeRoute.useParams();
    const { file } = codeRoute.useSearch();
    return <CodeView key={repoId} repoId={repoId} file={file} />;
  },
});

const activeRoute = createRoute({
  getParentRoute: () => windowRoute,
  path: "/active",
  component: lazyRouteComponent(() => import("./routes/ActiveAgents"), "ActiveAgents"),
});

const reviewsRoute = createRoute({
  getParentRoute: () => windowRoute,
  path: "/reviews",
  component: lazyRouteComponent(() => import("./routes/ReviewRequests"), "ReviewRequests"),
});

const pullsRoute = createRoute({
  getParentRoute: () => windowRoute,
  path: "/pulls",
  /** `pr`: the link of the pull request open beside the list. */
  validateSearch: (search: Record<string, unknown>): { pr?: string } =>
    typeof search.pr === "string" ? { pr: search.pr } : {},
  loader: () => MyPullRequests.preload?.(),
  component: function PullsRoute() {
    const { pr } = pullsRoute.useSearch();
    return <MyPullRequests openUrl={pr} />;
  },
});

const issuesRoute = createRoute({
  getParentRoute: () => windowRoute,
  path: "/issues",
  component: lazyRouteComponent(() => import("./routes/AssignedIssues"), "AssignedIssues"),
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: () => {
    throw redirect({ to: "/settings/$section", params: { section: "connections" } });
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/$section",
  beforeLoad: ({ params }) => {
    if (!isSettingsSection(params.section)) throw notFound();
  },
  loader: () => Settings.preload?.(),
  // The shutter in Root draws Settings over the outlet; the route keeps the URL, the redirect,
  // not found and the chunk preload.
  component: function SettingsRoute() {
    const { section } = settingsRoute.useParams();
    return isSettingsSection(section) ? null : <NotFound />;
  },
});

/** Stats replaces both panes. */
const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stats",
  component: lazyRouteComponent(() => import("./routes/Stats"), "Stats"),
});

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    gridRoute.addChildren([
      homeRoute,
      windowRoute.addChildren([
        taskRoute,
        backlogRoute,
        codeRoute,
        activeRoute,
        reviewsRoute,
        pullsRoute,
        issuesRoute,
      ]),
    ]),
  ]),
  settingsIndexRoute,
  settingsRoute,
  statsRoute,
]);

// Top-level view changes wipe in (route-transition.ts). Gated on View Transition types: without
// them the router would run an untyped crossfade on every navigation instead. Navigations into or
// out of Settings skip the wipe: the shutter animates those.
export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultViewTransition: supportsRouteTransition()
    ? {
        types: ({ fromLocation, toLocation }) =>
          (fromLocation !== undefined && isSettingsPath(fromLocation.pathname)) ||
          isSettingsPath(toLocation.pathname)
            ? false
            : routeTransitionTypes(
                fromLocation?.pathname,
                toLocation.pathname,
                prefersReducedMotion(),
              ),
      }
    : false,
});

// Remember where each task entry was opened from, so leaving the window lands there.
router.subscribe("onResolved", ({ fromLocation, toLocation }) => {
  recordWindowOrigin(fromLocation?.pathname, toLocation);
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
