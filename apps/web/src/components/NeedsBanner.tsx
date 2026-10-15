import type { ReactNode } from "react";
import { WarnIcon } from "./icons";

/** The main view's needs-you banner: why the task waits on the user, and the action that resolves it. */
export function NeedsBanner({
  title,
  children,
  actions,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div role="status" className="relative isolate">
      {/* The wash is translucent, so the glow is a sibling halo rather than a filter on the box. */}
      <span aria-hidden className="bw-chamfer-halo bw-chamfer-halo-needs" />
      <div className="bw-chamfer bw-chamfer-needs flex flex-wrap items-center gap-3 bg-needs-wash px-3.5 py-2.5">
        <WarnIcon size="lg" className="text-magenta" />
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="font-semibold text-magenta text-shadow-glow-needs">{title}</span>
          {children && <span className="text-meta text-foreground">{children}</span>}
        </div>
        {actions}
      </div>
    </div>
  );
}
