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
import { Backlog } from "./routes/Backlog";
import { Home } from "./routes/Home";
import { Settings } from "./routes/Settings";
import { TaskView } from "./routes/TaskView";
import { isSettingsSection } from "./settings-sections";
import { useThemeHotkey } from "./theme";

const rootRoute = createRootRoute({
  component: function Root() {
    // App-wide shortcuts that must work on every route, Settings included.
    useThemeHotkey();
    return (
      <div className="h-full min-h-0 bg-background">
        <Outlet />
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
    <div className="flex h-full min-w-0">
      <Inbox />
      <main className="h-full min-w-0 flex-1 bg-background">
        <Outlet />
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

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([homeRoute, taskRoute, backlogRoute]),
  settingsIndexRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
