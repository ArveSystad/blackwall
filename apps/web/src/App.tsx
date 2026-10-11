import { documentTitle } from "@blackwall/shared";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { CredentialProvider } from "./components/CredentialProvider";
import { LiveProvider } from "./components/LiveProvider";
import { needsYouCount } from "./inbox";
import {
  canNotify,
  needsYouIds,
  needsYouToNotify,
  notificationPermission,
  notificationsEnabled,
} from "./notifications";
import { createQueryClient, tasksQuery } from "./query";
import { router } from "./router";
import { GATE_REASONS } from "./task-view";

/** Keeps the tab title at `(N) blackwall`, N being the tasks that need the user. */
function TabTitle() {
  const tasks = useQuery(tasksQuery);
  const count = needsYouCount(tasks.data ?? []);
  useEffect(() => {
    document.title = documentTitle(count);
  }, [count]);
  return null;
}

/**
 * Shows a desktop notification when the needs-you count rises, if the user opted in. Clicking it
 * brings blackwall to the front on that task.
 */
function NeedsYouNotifier() {
  const tasks = useQuery(tasksQuery);
  // Null until the first data arrives, so tasks already waiting on load don't notify.
  const previousIds = useRef<string[] | null>(null);
  useEffect(() => {
    if (!tasks.data) return;
    const task = needsYouToNotify(previousIds.current, tasks.data);
    // Always move on, so nothing piles up while notifications are off.
    previousIds.current = needsYouIds(tasks.data);
    // Read at the change, not watched: turning notifications on must not replay the last one.
    if (!task || !canNotify(notificationsEnabled(), notificationPermission())) return;
    try {
      const notification = new Notification(task.title, {
        body: task.gate ? GATE_REASONS[task.gate] : "Needs you",
        tag: task.id,
      });
      notification.onclick = () => {
        window.focus();
        void router.navigate({ to: "/tasks/$taskId", params: { taskId: task.id } });
        notification.close();
      };
    } catch {
      // Some browsers (Android Chrome) only allow notifications from a service worker.
    }
  }, [tasks.data]);
  return null;
}

export function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <LiveProvider>
        <CredentialProvider>
          <TabTitle />
          <NeedsYouNotifier />
          <RouterProvider router={router} />
        </CredentialProvider>
      </LiveProvider>
    </QueryClientProvider>
  );
}
