import type { ReactNode } from "react";

/** A labelled group of rows: label, count and a rule. */
export function Section({
  label,
  ariaLabel,
  count,
  children,
}: {
  label: string;
  ariaLabel: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section aria-label={ariaLabel}>
      <h2 className="m-0 flex items-center gap-2 px-1.5 pt-1 pb-1">
        <span className="label text-muted-foreground">{label}</span>
        <span className="mono text-label text-faint">{count}</span>
        <span className="h-px flex-1 bg-border" />
      </h2>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{children}</ul>
    </section>
  );
}
