import { Select as SelectPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { CheckIcon, ChevronDownIcon } from "../icons";

/** Themed dropdown for options that need more than text (icons, counts); otherwise use `Select`. */
export const SelectMenu = SelectPrimitive.Root;
export const SelectMenuGroup = SelectPrimitive.Group;

/**
 * The closed menu, styled as an input; shows the selected item's text and a chevron, or
 * `placeholder` while the value is empty.
 */
export function SelectMenuTrigger({
  className,
  placeholder,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger> & { placeholder?: ReactNode }) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "bw-chamfer bw-chamfer-focus inline-flex h-[30px] w-full cursor-pointer items-center justify-between gap-2 bg-card px-2 text-body text-foreground-strong outline-none [--bw-chamfer-line:var(--border-strong)] disabled:cursor-not-allowed disabled:opacity-45 data-[placeholder]:text-muted-foreground [&>span]:flex [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-1.5",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.Value placeholder={placeholder} />
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon size="sm" className="shrink-0 text-muted-foreground" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** The open menu: a popover below the trigger, at least as wide as it. */
export function SelectMenuContent({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={4}
        className={cn(
          "bw-no-drag z-50 max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] drop-shadow-pop",
          className,
        )}
        {...props}
      >
        {/* clip-path drops box-shadow, so the unclipped Content casts the pop around this panel. */}
        <div className="bw-chamfer flex max-h-[inherit] flex-col overflow-hidden bg-popover p-1">
          <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
        </div>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

/** One option. `children` is what the trigger shows once picked; `trailing` shows only in the menu. */
export function SelectMenuItem({
  className,
  children,
  trailing,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item> & { trailing?: ReactNode }) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "bw-chamfer flex cursor-pointer items-center gap-2 px-2 py-1.5 text-body outline-none select-none [--bw-chamfer-line:transparent] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[highlighted]:bg-muted data-[state=checked]:text-foreground-strong",
        className,
      )}
      {...props}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon size="sm" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1 [&>span]:flex [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-1.5">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      </span>
      {trailing && <span className="ml-4 shrink-0">{trailing}</span>}
    </SelectPrimitive.Item>
  );
}

/** Heading over a group of items. */
export function SelectMenuLabel({
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn("label px-2 pt-1.5 pb-1 text-muted-foreground", className)}
      {...props}
    />
  );
}

/** Thin rule between groups. */
export function SelectMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn("my-1 h-px bg-border", className)} {...props} />;
}
