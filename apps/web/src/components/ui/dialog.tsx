import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;

/**
 * Modal over a dimmed shell. Esc and the overlay close it through `onOpenChange`. It centres in
 * the area below the desktop title bar. The content sits in a chamfered HUD panel that scans open
 * in 150ms; the panel is clipped, so its drop shadow lives on the unclipped `Content`.
 */
export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="bw-no-drag fixed inset-0 z-50 bg-overlay backdrop-blur-[2px]" />
      <DialogPrimitive.Content
        className={cn(
          "fixed top-[calc(50%_+_var(--bw-titlebar-h)/2)] left-1/2 z-50 w-[calc(100%-32px)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 drop-shadow-pop focus:outline-none",
          className,
        )}
        {...props}
      >
        <div className="bw-chamfer animate-scan-wipe overflow-hidden bg-modal text-foreground">
          {children}
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("m-0 text-heading font-semibold text-foreground-strong", className)}
      {...props}
    />
  );
}

/** The dialog's action row, right-aligned on the card background. */
export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 border-t border-border bg-card px-5 py-3",
        className,
      )}
      {...props}
    />
  );
}
