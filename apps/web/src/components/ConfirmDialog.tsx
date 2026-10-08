import { useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Kbd } from "./ui/kbd";

/**
 * Asks before a destructive action. Esc cancels; Enter confirms, since the
 * confirm button has focus. A failed action keeps the dialog open with its error.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[420px]">
        <div className="flex flex-col gap-2 px-5 pt-[18px] pb-4">
          <DialogTitle className="m-0 text-heading font-semibold text-foreground-strong">
            {title}
          </DialogTitle>
          <DialogDescription className="m-0 text-pretty">{children}</DialogDescription>
          {error && (
            <p className="m-0 text-meta text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border bg-card px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            autoFocus
            className="border-destructive/50 text-destructive hover:bg-destructive/12"
            disabled={pending}
            onClick={() => void confirm()}
          >
            {pending ? "Working…" : confirmLabel}
            <Kbd aria-hidden="true">↵</Kbd>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
