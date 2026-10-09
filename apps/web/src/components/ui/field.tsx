import { useId, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { FieldContext } from "./field-context";

export const fieldLabel = "text-meta font-medium text-foreground-strong";

/** Inline error, announced when it appears. */
export function ErrorText({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("m-0 text-meta text-destructive", className)} role="alert">
      {children}
    </p>
  );
}

/**
 * A labelled form field: the label above its control, with an optional hint below.
 *
 * A plain Field holds exactly one `Input`, `Textarea`, `Select` or `SecretInput`, which picks up
 * the label's `id` and the hint as its description. For anything else (`Segmented`, a select
 * menu, several controls or read-only text) pass `group`: the label then names a `role="group"`.
 */
export function Field({
  label,
  hint,
  group = false,
  id,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  group?: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const auto = useId();
  const fieldId = id ?? auto;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const hintText = hint && (
    <span id={hintId} className="text-meta text-muted-foreground">
      {hint}
    </span>
  );

  if (group) {
    return (
      <div
        role="group"
        aria-labelledby={`${fieldId}-label`}
        aria-describedby={hintId}
        className={cn("flex flex-col gap-1.5", className)}
      >
        <span id={`${fieldId}-label`} className={fieldLabel}>
          {label}
        </span>
        {children}
        {hintText}
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={fieldId} className={fieldLabel}>
        {label}
      </label>
      <FieldContext.Provider value={{ id: fieldId, describedBy: hintId }}>
        {children}
      </FieldContext.Provider>
      {hintText}
    </div>
  );
}
