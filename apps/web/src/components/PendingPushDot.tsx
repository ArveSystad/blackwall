import { useQuery } from "@tanstack/react-query";
import { hasPendingPush, pendingPushLabel } from "../backlog";
import { repoSyncQuery } from "../query";

/**
 * A magenta dot that tells the repo's main branch has commits to push: "3 commits to push to main".
 * It sits at its parent's top-right corner, so the parent must be `relative` and must not clip
 * (a `.bw-chamfer` button would): render it as the button's sibling.
 */
export function PendingPushDot({ repoId }: { repoId: string }) {
  const { data } = useQuery(repoSyncQuery(repoId));
  if (!hasPendingPush(data)) return null;
  const label = pendingPushLabel(data);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="absolute -top-1 -right-1 size-2 rounded-full bg-needs shadow-glow-needs"
    />
  );
}
