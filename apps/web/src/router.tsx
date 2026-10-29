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
import { Inbox } from "./components/Inbox";
import { NotFound } from "./components/NotFound";
import { SearchPalette } from "./components/SearchPalette";
import { TopBar } from "./components/TopBar";
import { useVoiceActions } from "./components/use-voice-actions";
import { VoiceTaskModal } from "./components/VoiceTaskModal";
import { Home } from "./routes/Home";
import { prefersReducedMotion } from "./reduced-motion";
import { routeTransitionTypes, supportsRouteTransition } from "./route-transition";
import { isSettingsSection } from "./settings-sections";
import { useChatHotkey } from "./chat";
import { useSearchHotkey } from "./search-palette";
import { useThemeHotkey } from "./theme";

// Heavier routes load as their own chunks. The wrapped ones get a `loader` that preloads the
// chunk, since the router only preloads a route's own `component` on hover.
const TaskView = lazyRouteComponent(() => import("./routes/TaskView"), "TaskView");
const Backlog = lazyRouteComponent(() => import("./routes/Backlog"), "Backlog");
const Settings = lazyRouteComponent(() => import("./routes/Settings"), "Settings");

const rootRoute = createRootRoute({
  component: function Root() {
    // App-wide shortcuts that must work on every route, Settings included.
    useThemeHotkey();
    useChatHotkey();
    useSearchHotkey();
    useVoiceActions();
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="bw-titlebar" aria-hidden />
        <TopBar />
        {/* The chat stays open beside every page: the shell, Settings and Stats. */}
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1 [view-transition-name:bw-route]">
            <Outlet />
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

/** Two-pane shell: the inbox on the left, the selected task (or home) on the right. */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: () => (
    <ArchiveLaunchesProvider>
      <div className="flex h-full min-w-0">
        <Inbox />
        <main className="flex h-full min-w-0 flex-1 flex-col bg-background">
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </main>
      </div>
    </ArchiveLaunchesProvider>
  ),
});

const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  component: Home,
});

const taskRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/tasks/$taskId",
  loader: () => TaskView.preload?.(),
  component: function TaskRoute() {
    const { taskId } = taskRoute.useParams();
    // Keyed so switching tasks starts from a fresh view.
    return <TaskView key={taskId} taskId={taskId} />;
  },
});

const backlogRoute = createRoute({
  getParentRoute: () => shellRoute,
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

const activeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/active",
  component: lazyRouteComponent(() => import("./routes/ActiveAgents"), "ActiveAgents"),
});

const reviewsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/reviews",
  component: lazyRouteComponent(() => import("./routes/ReviewRequests"), "ReviewRequests"),
});

const issuesRoute = createRoute({
  getParentRoute: () => shellRoute,
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
  component: function SettingsRoute() {
    const { section } = settingsRoute.useParams();
    return isSettingsSection(section) ? <Settings section={section} /> : <NotFound />;
  },
});

/** Stats replaces both panes, like Settings. */
const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stats",
  component: lazyRouteComponent(() => import("./routes/Stats"), "Stats"),
});

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    homeRoute,
    taskRoute,
    backlogRoute,
    activeRoute,
    reviewsRoute,
    issuesRoute,
  ]),
  settingsIndexRoute,
  settingsRoute,
  statsRoute,
]);

// Top-level view changes wipe in (route-transition.ts). Gated on View Transition types: without
// them the router would run an untyped crossfade on every navigation instead.
export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultViewTransition: supportsRouteTransition()
    ? {
        types: ({ fromLocation, toLocation }) =>
          routeTransitionTypes(fromLocation?.pathname, toLocation.pathname, prefersReducedMotion()),
      }
    : false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
