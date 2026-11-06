import type { ProjectRun, RepoView } from "@blackwall/shared";
import { useId, useState } from "react";
import { CARD_MARGIN, cardLeft } from "../agent-dots";
import { useNow } from "../hooks";
import { cn } from "../lib/utils";
import { reactorStatusLabel, reactorVisual, type ReactorVisual } from "../reactor";
import type { Tower } from "../skyline";
import { formatUptime } from "../system-info";
import { ProjectOutputModal } from "./ProjectOutputModal";
import { useProjectRun } from "./use-project-run";

/** The pylon card's width. */
const CARD_WIDTH = 200;
/** The pylon's hit target; its visible pylon is 6×9px at the bottom. */
const HIT_W = 12;
const HIT_H = 14;
/** How far the hit target reaches below the horizon, over the tower's foot. */
const HIT_BELOW = 2;
/** The visible pylon's size, as in `.bw-reactor`. */
const PYLON_W = 6;
const PYLON_H = 9;

/** The card's status tone: the run output chip's colours. */
const LABEL_TONES: Record<Exclude<ReactorVisual, "sputter">, string> = {
  "power-up": "text-cyan",
  hum: "text-done",
  "power-down": "text-muted-foreground",
};

/** How long the run has been up; ticks each second, only while the card is open. */
function ReactorUptime({ startedAt }: { startedAt: Date }) {
  const now = useNow(1000);
  const seconds = Math.max(0, (now.getTime() - startedAt.getTime()) / 1000);
  return <span className="mono text-meta text-muted-foreground">Up {formatUptime(seconds)}</span>;
}

/** One pylon: a button that opens its run's output, with a hover/focus card. */
function ReactorPylon({
  tower,
  repo,
  run,
  visual,
  overlayWidth,
  onHot,
  onOpenOutput,
}: {
  tower: Tower;
  repo: RepoView;
  run: ProjectRun;
  visual: Exclude<ReactorVisual, "sputter">;
  overlayWidth: number;
  onHot: (repoId: string, on: boolean) => void;
  onOpenOutput: (repoId: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = (hovered || focused) && !dismissed;
  const cardId = useId();
  const width = Math.min(CARD_WIDTH, overlayWidth - 2 * CARD_MARGIN);
  const label = reactorStatusLabel(run.status);
  const top = tower.base + HIT_BELOW - HIT_H;

  return (
    <>
      <button
        type="button"
        aria-label={`${repo.name} project: ${label}. Open output`}
        aria-describedby={open ? cardId : undefined}
        style={{ left: tower.x - HIT_W / 2, top, width: HIT_W, height: HIT_H }}
        className="pointer-events-auto absolute flex cursor-pointer items-end justify-center border-0 bg-transparent p-0 focus-visible:shadow-ring"
        onClick={() => onOpenOutput(repo.id)}
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          setHovered(true);
          onHot(repo.id, true);
        }}
        onPointerLeave={() => {
          setHovered(false);
          onHot(repo.id, focused);
          if (!focused) setDismissed(false);
        }}
        onFocus={() => {
          setFocused(true);
          onHot(repo.id, true);
        }}
        onBlur={() => {
          setFocused(false);
          onHot(repo.id, hovered);
          if (!hovered) setDismissed(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            setDismissed(true);
          }
        }}
      >
        <span
          aria-hidden="true"
          className="bw-reactor"
          data-visual={visual}
          data-hot={open || undefined}
          style={{ marginBottom: HIT_BELOW }}
        />
      </button>
      {open && (
        <div
          id={cardId}
          role="tooltip"
          style={{ left: cardLeft(tower.x, width, overlayWidth), top: top - 4, width }}
          className="absolute z-30 -translate-y-full drop-shadow-pop"
        >
          {/* The pop sits on the unclipped tooltip: clip-path drops the panel's own shadow. */}
          <div className="bw-chamfer flex flex-col gap-1 bg-popover p-3 text-left">
            <span className="truncate font-medium text-foreground-strong">{repo.name}</span>
            <span className={cn("label", LABEL_TONES[visual])}>{label}</span>
            <ReactorUptime startedAt={run.startedAt} />
            <span className="text-meta text-muted-foreground">Click to open output</span>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Each running project as a small reactor pylon at the foot of its repo's
 * tower (see `reactor.ts`): a cyan flicker while it starts, a green hum while
 * it runs, a dim fade while it stops, and a one-shot red sputter
 * (`useReactorSputters`) when it crashes. Hovering a pylon lights its tower;
 * clicking it asks Home to open the run's output (`ReactorOutput`), so the
 * window outlives the pylon. Render inside the `Repos` nav, after the towers.
 */
export function GridReactors({
  towers,
  runsByRepo,
  reposById,
  sputters,
  overlayWidth,
  onHot,
  onOpenOutput,
}: {
  towers: readonly Tower[];
  runsByRepo: ReadonlyMap<string, ProjectRun>;
  reposById: ReadonlyMap<string, RepoView>;
  /** Sputter counts by repo id, from `useReactorSputters`. */
  sputters: ReadonlyMap<string, number>;
  overlayWidth: number;
  onHot: (repoId: string, on: boolean) => void;
  onOpenOutput: (repoId: string) => void;
}) {
  return (
    <>
      {towers.map((tower) => {
        const repo = reposById.get(tower.repoId);
        if (!repo) return null;
        const sputter = sputters.get(tower.repoId);
        if (sputter !== undefined) {
          return (
            <span
              key={`sputter:${tower.repoId}:${sputter}`}
              aria-hidden="true"
              className="bw-reactor-sputter"
              style={{
                left: tower.x - PYLON_W / 2,
                top: tower.base - PYLON_H,
                width: PYLON_W,
                height: PYLON_H,
              }}
            />
          );
        }
        const run = runsByRepo.get(tower.repoId);
        const visual = run ? reactorVisual(run.status) : null;
        if (!run || !visual) return null;
        return (
          <ReactorPylon
            key={`pylon:${tower.repoId}`}
            tower={tower}
            repo={repo}
            run={run}
            visual={visual}
            overlayWidth={overlayWidth}
            onHot={onHot}
            onOpenOutput={onOpenOutput}
          />
        );
      })}
    </>
  );
}

function ReactorOutputModal({ repo, onClose }: { repo: RepoView; onClose: () => void }) {
  const project = useProjectRun(repo);
  return <ProjectOutputModal repo={repo} project={project} onClose={onClose} />;
}

/**
 * The output window a pylon opened, owned by Home so it stays open after the
 * run stops or crashes and after the pylon or the agents view goes away.
 * Renders nothing once the repo is gone.
 */
export function ReactorOutput({
  repoId,
  repos,
  onClose,
}: {
  repoId: string;
  repos: readonly RepoView[];
  onClose: () => void;
}) {
  const repo = repos.find((r) => r.id === repoId);
  if (!repo) return null;
  return <ReactorOutputModal repo={repo} onClose={onClose} />;
}
