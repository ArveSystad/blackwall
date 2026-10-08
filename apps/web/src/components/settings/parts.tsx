import { useEffect, useRef, type ReactNode } from "react";
import { isModKey, modKeyLabel } from "../../keyboard";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";

export const fieldLabel = "text-meta font-medium text-foreground-strong";

export function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 px-4 py-6 text-muted-foreground">{children}</p>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 text-meta text-destructive" role="alert">
      {children}
    </p>
  );
}

/** A settings section's title row, with its actions on the right. */
export function SectionHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-[52px] items-center gap-2 border-b border-border px-4 py-3">
      <h1 className="m-0 text-heading font-semibold text-foreground-strong">{title}</h1>
      <span className="flex-1" />
      {children}
    </div>
  );
}

/** Runs `onSave` on ⌘S / Ctrl S while `enabled`, including from text fields. */
function useSaveShortcut(enabled: boolean, onSave: () => void): void {
  const save = useRef(onSave);
  useEffect(() => {
    save.current = onSave;
  });
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "s" || !isModKey(event)) return;
      event.preventDefault();
      save.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/** Footer with the unsaved-changes marker, Discard and Save (⌘S). */
export function SaveBar({
  dirty,
  saving,
  error,
  onDiscard,
  onSave,
  saveLabel = "Save",
  className,
}: {
  dirty: boolean;
  saving: boolean;
  error?: string | null | undefined;
  onDiscard: () => void;
  onSave: () => void;
  saveLabel?: string;
  className?: string;
}) {
  useSaveShortcut(dirty && !saving, onSave);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2.5 border-t border-border px-5 py-3",
        className,
      )}
    >
      {error ? (
        <ErrorText>{error}</ErrorText>
      ) : (
        dirty && (
          <span className="inline-flex items-center gap-1.5 text-meta text-muted-foreground">
            <span className="size-1.5 rounded-full bg-sev-medium" aria-hidden="true" />
            Unsaved changes
          </span>
        )
      )}
      <span className="flex-1" />
      <Button variant="ghost" disabled={!dirty || saving} onClick={onDiscard}>
        Discard
      </Button>
      <Button variant="primary" disabled={!dirty || saving} onClick={onSave}>
        {saving ? "Saving…" : saveLabel}
        <Kbd onFill aria-hidden="true">
          {modKeyLabel("S")}
        </Kbd>
      </Button>
    </div>
  );
}
