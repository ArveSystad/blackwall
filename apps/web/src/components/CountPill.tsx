import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "../lib/utils";
import { useCountBoom } from "./use-count-boom";

/**
 * A pill in the home grid's bottom row: a count gathered from every GitHub
 * host. While above zero the whole pill glows magenta (with a blinking dot)
 * and the count and label share the colour. When the count rises from zero
 * it booms yellow once, then settles to magenta. The parent row places it, and
 * must sit in a clipping layer (see Home).
 */
export function CountPill<T extends { errors: { host: string; message: string }[] }>({
  to,
  query,
  count: countOf,
  label: labelOf,
  unit,
  loadingLabel,
  errorLabel,
}: {
  to: "/reviews" | "/issues";
  query: UseQueryResult<T>;
  count: (data: T) => number;
  /** The full label, also the accessible name. */
  label: (count: number) => string;
  /** The short text after the number. */
  unit: (count: number) => string;
  loadingLabel: string;
  errorLabel: string;
}) {
  const data = query.data;
  const count = data ? countOf(data) : 0;
  const hostErrors = data?.errors ?? [];
  // A failed refetch keeps the last data; only no data, or every host failing, is an error.
  const failed = (query.isError && !data) || (!!data && count === 0 && hostErrors.length > 0);
  const errorTitle = query.error
    ? query.error.message
    : hostErrors.map((e) => e.message).join("\n");
  const label = !data && !failed ? loadingLabel : failed ? errorLabel : labelOf(count);
  const needed = !failed && count > 0;
  const boom = useCountBoom(to, data && !failed ? count : null);

  return (
    <Link
      to={to}
      aria-label={label}
      title={hostErrors.length > 0 || failed ? errorTitle : undefined}
      className={cn(
        "bw-chamfer-fill bw-chamfer-focus pointer-events-auto flex h-9 items-center gap-2 px-4 whitespace-nowrap no-underline [--bw-chamfer-bg:var(--bg-4)] hover:no-underline focus-visible:outline-none",
        needed
          ? "drop-shadow-glow-needs [--bw-chamfer-line:var(--magenta)]"
          : "drop-shadow-pop [--bw-chamfer-line:var(--border-strong)]",
        needed ? "text-needs text-shadow-glow-needs" : "text-muted-foreground",
      )}
    >
      {boom !== null && (
        <>
          {/* z-[-1] paints after the fill's ::before, so the flash shows over it, under the text. */}
          <span key={`flash:${boom}`} aria-hidden="true" className="bw-assigned-flash z-[-1]" />
          <span
            key={`boom:${boom}`}
            aria-hidden="true"
            className="bw-boom bw-assigned -z-10 left-1/2 top-1/2"
          />
        </>
      )}
      {!data || failed ? (
        <span className="text-meta">{label}</span>
      ) : (
        <>
          {needed && (
            <span aria-hidden="true" className="size-2 animate-blink-needs rounded-full bg-needs" />
          )}
          <span className={cn("mono text-[18px] font-semibold", !needed && "text-faint")}>
            {count}
          </span>
          <span className="text-meta">{unit(count)}</span>
        </>
      )}
    </Link>
  );
}
