import type { Task } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { CARD_MARGIN, cardLeft } from "../agent-dots";
import { clockTime } from "../backlog";
import { layoutStars, msUntilNextMidnight, nextArrivals, starsToday } from "../grid-stars";
import { cn } from "../lib/utils";
import { doneTimesQuery } from "../query";
import { startOfDay } from "../stats";

/** Card width; the 12px link's half-size plus the margin sets its gap from the star. */
const CARD_WIDTH = 220;
const LINK_HALF = 6;
/** Stars this close to the pane's top open their card below, not above. */
const CARD_BELOW_Y = 64;

/** One star: a 12px link to its task, the twinkling dot inside it, and its hover/focus card. */
function Star({
  task,
  doneAt,
  x,
  y,
  size,
  opacity,
  twinkleS,
  twinkleDelayS,
  arriving,
  overlayWidth,
}: {
  task: Task;
  doneAt: Date;
  x: number;
  y: number;
  size: number;
  opacity: number;
  twinkleS: number;
  twinkleDelayS: number;
  /** New since the layer loaded: fades in after the done supernova. */
  arriving: boolean;
  overlayWidth: number;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = (hovered || focused) && !dismissed;
  const cardId = useId();
  const time = clockTime(doneAt);
  const width = Math.min(CARD_WIDTH, overlayWidth - 2 * CARD_MARGIN);
  const below = y < CARD_BELOW_Y;

  return (
    <>
      <Link
        to="/tasks/$taskId"
        params={{ taskId: task.id }}
        aria-label={`${task.title}: done ${time}`}
        aria-describedby={open ? cardId : undefined}
        style={{ left: x, top: y }}
        className={cn(
          "pointer-events-auto absolute flex size-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:shadow-ring",
          open && "z-20",
        )}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") setHovered(true);
        }}
        onPointerLeave={() => {
          setHovered(false);
          if (!focused) setDismissed(false);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
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
          className={cn("bw-star-slot", arriving && "bw-star-arrive")}
          style={
            {
              "--star-size": `${size}px`,
              "--star-opacity": opacity,
              "--twinkle-duration": `${twinkleS}s`,
              "--twinkle-delay": `${twinkleDelayS}s`,
            } as CSSProperties
          }
        >
          <span className="bw-star" />
        </span>
      </Link>
      {open && (
        <div
          id={cardId}
          role="tooltip"
          style={{
            left: cardLeft(x, width, overlayWidth),
            top: below ? y + LINK_HALF + CARD_MARGIN : y - LINK_HALF - CARD_MARGIN,
            width,
          }}
          className={cn("absolute z-30 drop-shadow-pop", !below && "-translate-y-full")}
        >
          {/* The pop sits on the unclipped tooltip: clip-path drops the panel's own shadow. */}
          <div className="bw-chamfer flex flex-col gap-1 bg-popover p-3 text-left">
            <span className="min-w-0 truncate font-medium text-foreground-strong">
              {task.title}
            </span>
            <span className="label text-done">Done · {time}</span>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Today's finished tasks as small, dim stars in the home grid's sky (see
 * `grid-stars.ts`): one per task done since local midnight, archived ones
 * included and uncapped, cleared at the next midnight. Each star keeps a
 * hashed spot above the horizon, clear of the running sign, twinkles slowly
 * and links to its task, with a hover/focus card of its title and finish
 * time. Ships (GridShots, -z-10) fly behind it; a press on a star never fires
 * a shot, a press elsewhere still does.
 * Three nested opacities multiply and never override each other: the slot
 * fades in a new star (`.bw-star-arrive`), `.bw-star` holds its base
 * brightness, and its `::before` twinkles. A star is new when it shows up
 * after the done times first load; that first loaded snapshot only seeds
 * the seen ids, so a reload or remount shows earlier stars at once. Seeding
 * waits for the done times, so stars that load late never count as new.
 * Under reduced motion the stars are still. Dims with the grid fade like
 * `RunningSign` (`faded`). The parent must be `relative`.
 */
export function GridStars({ tasks, faded }: { tasks: ReadonlyMap<string, Task>; faded: boolean }) {
  const doneTimes = useQuery(doneTimesQuery);
  const [dayStart, setDayStart] = useState(() => startOfDay(new Date()));
  useEffect(() => {
    const timer = window.setTimeout(
      () => setDayStart(startOfDay(new Date())),
      msUntilNextMidnight(new Date()),
    );
    return () => window.clearTimeout(timer);
  }, [dayStart]);

  const stars = useMemo(
    () => (doneTimes.data ? starsToday(doneTimes.data, tasks, dayStart) : null),
    [doneTimes.data, tasks, dayStart],
  );

  // Star ids seen so far; ids missing from it on a later snapshot fade in.
  const [seenStars, setSeenStars] = useState<typeof stars>(null);
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);
  const [arriving, setArriving] = useState<ReadonlySet<string>>(new Set());
  if (stars && stars !== seenStars) {
    setSeenStars(stars);
    const next = nextArrivals(
      seen,
      stars.map((s) => s.task.id),
    );
    setSeen(next.seen);
    if (next.arrived.length > 0) setArriving(new Set([...arriving, ...next.arrived]));
  }

  const ref = useRef<HTMLElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(
    () => (size && stars ? layoutStars(stars, size.width, size.height) : null),
    [stars, size],
  );

  return (
    <nav
      ref={ref}
      aria-label="Done today"
      className="bw-star-layer pointer-events-none absolute inset-0 z-[5] overflow-hidden"
      data-full={faded ? undefined : ""}
    >
      {size &&
        layout &&
        stars?.map(({ task, doneAt }) => {
          const spot = layout.get(task.id);
          if (!spot) return null;
          return (
            <Star
              key={task.id}
              task={task}
              doneAt={doneAt}
              {...spot}
              arriving={arriving.has(task.id)}
              overlayWidth={size.width}
            />
          );
        })}
    </nav>
  );
}
