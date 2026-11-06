import type { PullRequestStackLookup } from "@blackwall/shared";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { Kbd } from "./ui/kbd";

/**
 * Asks whether adding a PR of a stack also queues Review PR items for the
 * stack's other PRs. Esc cancels; Enter reviews the whole stack, as before.
 */
export function StackChoiceDialog({
  members,
  current,
  onChoose,
  onClose,
}: {
  /** The stack's open PRs, bottom first. */
  members: PullRequestStackLookup["prs"];
  /** The PR being added. */
  current: number;
  /** True: review the whole stack; false: only `current`. */
  onChoose: (all: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[420px]">
        <div className="flex flex-col gap-2 px-5 pt-[18px] pb-4">
          <DialogTitle>Review the whole stack?</DialogTitle>
          <DialogDescription className="m-0 text-pretty">
            #{current} is one of {members.length} stacked pull requests. Reviewing all adds a
            waiting Review PR item for each of the others; PRs already worked on are skipped.
          </DialogDescription>
          <ol className="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px]">
            {members.map((pr) => (
              <li key={pr.number} className="flex min-w-0 gap-2">
                <span className="shrink-0 font-mono text-muted-foreground">#{pr.number}</span>
                <span className="truncate">{pr.title}</span>
                {pr.number === current && (
                  <span className="shrink-0 text-muted-foreground">← this PR</span>
                )}
              </li>
            ))}
          </ol>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="ghost" onClick={() => onChoose(false)}>
            Only #{current}
          </Button>
          <Button autoFocus onClick={() => onChoose(true)}>
            Review all {members.length}
            <Kbd aria-hidden="true">↵</Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
