import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CredentialProvider } from "./components/CredentialProvider";
import { LiveProvider } from "./components/LiveProvider";
import { needsYouCount } from "./inbox";
import { createQueryClient, tasksQuery } from "./query";
import { router } from "./router";
import { documentTitle } from "./title";

/** Keeps the tab title at `(N) blackwall`, N being the tasks that need the user. */
function TabTitle() {
  const tasks = useQuery(tasksQuery);
  const count = needsYouCount(tasks.data ?? []);
  useEffect(() => {
    document.title = documentTitle(count);
  }, [count]);
  return null;
}

export function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <LiveProvider>
        <CredentialProvider>
          <TabTitle />
          <RouterProvider router={router} />
        </CredentialProvider>
      </LiveProvider>
    </QueryClientProvider>
  );
}
