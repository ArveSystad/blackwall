import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  redirect,
} from "@tanstack/react-router";
import { Inbox } from "./components/Inbox";
import { NotFound } from "./components/NotFound";
import { RepoContextBar } from "./components/RepoContextBar";
import { ActiveAgents } from "./routes/ActiveAgents";
import { Backlog } from "./routes/Backlog";
import { Home } from "./routes/Home";
import { ReviewRequests } from "./routes/ReviewRequests";
import { Settings } from "./routes/Settings";
import { Stats } from "./routes/Stats";
import { TaskView } from "./routes/TaskView";
import { isSettingsSection } from "./settings-sections";
import { useThemeHotkey } from "./theme";

const rootRoute = createRootRoute({
  component: function Root() {
    // App-wide shortcuts that must work on every route, Settings included.
    useThemeHotkey();
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="bw-titlebar" aria-hidden />
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
    );
  },
  notFoundComponent: NotFound,
});

/**
 * Two-pane shell: the inbox on the left, the selected task (or home) on the right, under the
 * selected repo's status bar.
 */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: () => (
    <div className="flex h-full min-w-0">
      <Inbox />
      <main className="flex h-full min-w-0 flex-1 flex-col bg-background">
        <RepoContextBar />
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
    </div>
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
  component: function TaskRoute() {
    const { taskId } = taskRoute.useParams();
    // Keyed so switching tasks starts from a fresh view.
    return <TaskView key={taskId} taskId={taskId} />;
  },
});

const backlogRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/repos/$repoId/backlog",
  component: function BacklogRoute() {
    const { repoId } = backlogRoute.useParams();
    return <Backlog key={repoId} repoId={repoId} />;
  },
});

const activeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/active",
  component: ActiveAgents,
});

const reviewsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/reviews",
  component: ReviewRequests,
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
  component: function SettingsRoute() {
    const { section } = settingsRoute.useParams();
    return isSettingsSection(section) ? <Settings section={section} /> : <NotFound />;
  },
});

/** Stats replaces both panes, like Settings. */
const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stats",
  component: Stats,
});

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([homeRoute, taskRoute, backlogRoute, activeRoute, reviewsRoute]),
  settingsIndexRoute,
  settingsRoute,
  statsRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
