import type { Repo } from "@blackwall/shared";
import type { ReactNode } from "react";
import { StarIcon } from "./icons";
import {
  SelectMenuGroup,
  SelectMenuItem,
  SelectMenuLabel,
  SelectMenuSeparator,
} from "./ui/select-menu";

/**
 * Repo options for a `SelectMenu`: starred favourites in their own group, then the rest.
 * `trailing` adds per-repo detail that shows only in the open menu.
 */
export function RepoMenuItems<R extends Repo>({
  repos,
  trailing,
}: {
  repos: readonly R[];
  trailing?: (repo: R) => ReactNode;
}) {
  // The server sorts favourites first, so filtering keeps each group in order.
  const favourites = repos.filter((r) => r.favorite);
  const others = repos.filter((r) => !r.favorite);
  const repoItem = (r: R) => (
    <SelectMenuItem key={r.id} value={r.id} trailing={trailing?.(r)}>
      {r.favorite && <StarIcon size="sm" className="fill-current text-primary" />}
      <span className="truncate">{r.name}</span>
    </SelectMenuItem>
  );

  return (
    <>
      {favourites.length > 0 && (
        <SelectMenuGroup>
          <SelectMenuLabel>Favourites</SelectMenuLabel>
          {favourites.map(repoItem)}
        </SelectMenuGroup>
      )}
      {favourites.length > 0 && others.length > 0 && <SelectMenuSeparator />}
      {others.length > 0 && <SelectMenuGroup>{others.map(repoItem)}</SelectMenuGroup>}
    </>
  );
}
