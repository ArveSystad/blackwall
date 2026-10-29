import type { ReactNode } from "react";
import { ArchiveLaunchesContext, useArchiveLaunches } from "./use-archive-launches";

/**
 * Keeps the done dots' archive launches for the shell, so the inbox's
 * Archive all done and the home grid share them; read with `useArchive`. It
 * also keeps the inbox rows' crumbles, which the inbox, the grid and the task
 * page's Archive buttons all start.
 */
export function ArchiveLaunchesProvider({ children }: { children: ReactNode }) {
  const launch = useArchiveLaunches();
  return (
    <ArchiveLaunchesContext.Provider value={launch}>{children}</ArchiveLaunchesContext.Provider>
  );
}
