import { useState, type ReactNode } from "react";
import { errorMessage } from "../settings-forms";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { ErrorText } from "./ui/field";
import { Kbd } from "./ui/kbd";

/**
 * Asks before a destructive or outbound action. Esc cancels; Enter confirms, since the
 * confirm button has focus. A failed action keeps the dialog open with its error.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
  confirmVariant = "destructive",
  onCloseAutoFocus,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
  /** `default` for actions that aren't irreversible, like a push. */
  confirmVariant?: "destructive" | "default";
  /** Where focus goes on close; by default it returns to the trigger. */
  onCloseAutoFocus?: (event: Event) => void;
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
      setError(errorMessage(cause));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[420px]" onCloseAutoFocus={onCloseAutoFocus}>
        <div className="flex flex-col gap-2 px-5 pt-[18px] pb-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="m-0 text-pretty">{children}</DialogDescription>
          {error && <ErrorText>{error}</ErrorText>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            autoFocus
            variant={confirmVariant}
            disabled={pending}
            onClick={() => void confirm()}
          >
            {pending ? "Working…" : confirmLabel}
            <Kbd aria-hidden="true">↵</Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
