import type { Task } from "@blackwall/shared";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { CARD_MARGIN, cardLeft } from "../agent-dots";
import {
  ROW_PITCH,
  WINDOW_BOTTOM,
  WINDOW_W,
  windowColumns,
  windowSpan,
  type GridHot,
  type Tower,
} from "../skyline";

/** The tower card's width. */
const CARD_WIDTH = 200;

/**
 * One faint line per task from its main dot (`${taskId}:0`) up to its repo's
 * tower base. Sub-agent dots draw none of their own. A tether lights when its
 * task's dot or its repo's tower is hot. Keep this first in the booms layer,
 * so it paints under every dot.
 */
export function GridTethers({
  tasks,
  layout,
  towersById,
  hot,
  launching,
}: {
  tasks: ReadonlyMap<string, Task>;
  layout: ReadonlyMap<string, { x: number; y: number }>;
  towersById: ReadonlyMap<string, Tower>;
  hot: GridHot;
  launching: ReadonlyMap<string, unknown>;
}) {
  const hotRepoId = hot && "repoId" in hot ? hot.repoId : null;
  const hotTaskId = hot && "taskId" in hot ? hot.taskId : null;
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
      {[...tasks.values()].map((task) => {
        const tower = towersById.get(task.repoId);
        const spot = layout.get(`${task.id}:0`);
        if (!tower || !spot || launching.has(task.id)) return null;
        const lit = task.id === hotTaskId || task.repoId === hotRepoId;
        return (
          <line
            key={task.id}
            className="bw-tether"
            data-hot={lit || undefined}
            x1={spot.x}
            y1={spot.y}
            x2={tower.x}
            y2={tower.base}
          />
        );
      })}
    </svg>
  );
}

/** One tower: a link to its repo's backlog, with its windows, its beacon and a hover/focus card. */
function TowerLink({
  tower,
  overlayWidth,
  lit,
  frontZ,
  cardZ,
  onHot,
}: {
  tower: Tower;
  overlayWidth: number;
  lit: boolean;
  /** Above every tower: the focused tower's z, so its focus ring shows. */
  frontZ: number;
  /** Above every tower, for the card. */
  cardZ: number;
  onHot: (repoId: string, on: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = (hovered || focused) && !dismissed;
  const cardId = useId();
  const columns = windowColumns(tower.width);
  const span = windowSpan(columns);
  const width = Math.min(CARD_WIDTH, overlayWidth - 2 * CARD_MARGIN);

  return (
    <>
      <Link
        to="/repos/$repoId/backlog"
        params={{ repoId: tower.repoId }}
        aria-label={`${tower.name}: ${tower.doneCount} done, ${tower.running} running`}
        aria-describedby={open ? cardId : undefined}
        style={{
          // Exactly the tower, so the browser's hit test picks the front-most visible one.
          left: tower.x - tower.width / 2,
          top: tower.top,
          width: tower.width,
          height: tower.height,
          zIndex: focused ? frontZ : tower.z,
        }}
        className="pointer-events-auto absolute flex justify-center focus-visible:shadow-ring"
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          setHovered(true);
          onHot(tower.repoId, true);
        }}
        onPointerLeave={() => {
          setHovered(false);
          onHot(tower.repoId, focused);
          if (!focused) setDismissed(false);
        }}
        onFocus={() => {
          setFocused(true);
          onHot(tower.repoId, true);
        }}
        onBlur={() => {
          setFocused(false);
          onHot(tower.repoId, hovered);
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
          className="bw-tower"
          data-hot={lit || undefined}
          style={{ width: tower.width }}
        >
          {tower.windows.map((state, index) => {
            const row = Math.floor(index / columns);
            const column = index % columns;
            return (
              <span
                key={index}
                className="bw-tower-window"
                data-state={state}
                style={{
                  bottom: WINDOW_BOTTOM + row * ROW_PITCH,
                  left:
                    column === 0
                      ? `calc(50% - ${span / 2}px)`
                      : `calc(50% + ${span / 2 - WINDOW_W}px)`,
                }}
              />
            );
          })}
          {tower.favorite && <span className="bw-tower-beacon animate-beacon-blink" />}
        </span>
      </Link>
      {open && (
        <div
          id={cardId}
          role="tooltip"
          style={{
            left: cardLeft(tower.x, width, overlayWidth),
            top: tower.top - 8,
            width,
            zIndex: cardZ,
          }}
          className="absolute -translate-y-full drop-shadow-pop"
        >
          {/* The pop sits on the unclipped tooltip: clip-path drops the panel's own shadow. */}
          <div className="bw-chamfer flex flex-col gap-1 bg-popover p-3 text-left">
            <span className="truncate font-medium text-foreground-strong">{tower.name}</span>
            <span className="mono text-meta text-muted-foreground">{tower.doneCount} done</span>
            <span className="text-meta text-cyan">{tower.running} running</span>
            {tower.needs > 0 && (
              <span className="text-meta text-magenta">{tower.needs} need you</span>
            )}
            <span className="text-meta text-muted-foreground">Click to open backlog</span>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The registered repos as dim towers on the grid's horizon (see `skyline.ts`):
 * a seeded, overlapping city cluster right of centre, opposite the running
 * sign, with shorter towers in front. Height from its done tasks, cyan windows
 * for running tasks, magenta for those that need you, and a blinking beacon on
 * a favourite's roof. Each tower links to its repo's backlog; its hit box is
 * exactly the tower, so the front-most visible one takes the pointer. The
 * towers stack in their own context (`isolate`), painted before the pylons.
 * Render inside the `Repos` nav, which shares `GridAgents`' coordinates.
 */
export function GridSkyline({
  towers,
  overlayWidth,
  hotRepoId,
  onHot,
}: {
  towers: readonly Tower[];
  overlayWidth: number;
  /** The tower to light: the hot one, or the hot dot's repo. */
  hotRepoId: string | null;
  onHot: (repoId: string, on: boolean) => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 isolate">
      {towers.map((tower) => (
        <TowerLink
          key={tower.repoId}
          tower={tower}
          overlayWidth={overlayWidth}
          lit={tower.repoId === hotRepoId}
          frontZ={towers.length + 1}
          cardZ={towers.length + 2}
          onHot={onHot}
        />
      ))}
    </div>
  );
}
