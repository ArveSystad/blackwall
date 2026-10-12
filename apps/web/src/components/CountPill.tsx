import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "../lib/utils";

/**
 * A pill in the home grid's bottom row: a count gathered from every GitHub
 * host. While above zero the whole pill glows magenta (with a blinking dot)
 * and the count and label share the colour. The parent row places it.
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

  return (
    <Link
      to={to}
      aria-label={label}
      title={hostErrors.length > 0 || failed ? errorTitle : undefined}
      className={cn(
        "pointer-events-auto flex h-9 items-center gap-2 rounded-full border bg-popover px-4 whitespace-nowrap no-underline hover:no-underline focus-visible:border-cyan focus-visible:shadow-ring focus-visible:outline-none",
        needed ? "border-magenta" : "border-border-strong",
        needed ? "shadow-glow-needs" : "shadow-pop",
        needed ? "text-needs text-shadow-glow-needs" : "text-muted-foreground",
      )}
    >
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
