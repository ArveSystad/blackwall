import { Popover as PopoverPrimitive } from "radix-ui";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { isModKey } from "../../keyboard";
import { cn } from "../../lib/utils";
import { filterOptions, selectionSummary } from "../../multi-select";
import { stepSelection } from "../../search";
import { CheckIcon, ChevronDownIcon } from "../icons";
import { Input } from "./input";
import {
  selectContentClass,
  selectItemClass,
  selectPanelClass,
  selectTriggerClass,
} from "./select-menu";

/**
 * A dropdown that picks several options, styled like `SelectMenu`, with a filter on top.
 * Rows toggle on click or Enter and the popup stays open; Esc closes only the popup.
 */
export function MultiSelectMenu<T extends { id: string }>({
  id,
  "aria-labelledby": labelledBy,
  options,
  value,
  onChange,
  optionText,
  renderOption,
  trailing,
  placeholder,
  filterPlaceholder,
  className,
}: {
  /** The trigger's id, for a `<label htmlFor>`. */
  id?: string;
  "aria-labelledby"?: string;
  options: readonly T[];
  /** The picked ids, in pick order. */
  value: readonly string[];
  onChange: (ids: string[]) => void;
  /** The option's text, for filtering and for the trigger. */
  optionText: (option: T) => string;
  /** The row body; defaults to the option's text. */
  renderOption?: (option: T) => ReactNode;
  /** Detail after the row body, shown only in the open menu. */
  trailing?: (option: T) => ReactNode;
  placeholder?: ReactNode;
  filterPlaceholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const shown = filterOptions(options, query, optionText);
  const active = shown[index];
  const activeId = active ? `${listId}-${index}` : undefined;
  // Picks no longer among the options are left out of the summary.
  const summary = selectionSummary(
    value.flatMap((picked) => {
      const option = options.find((o) => o.id === picked);
      return option ? [optionText(option)] : [];
    }),
  );

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  function toggle(option: T) {
    onChange(
      value.includes(option.id) ? value.filter((v) => v !== option.id) : [...value, option.id],
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Stopped here, or React would carry them through the portal to the form.
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setIndex(stepSelection(index, event.key === "ArrowDown" ? 1 : -1, shown.length));
    } else if (event.key === "Enter" && !isModKey(event.nativeEvent)) {
      event.preventDefault();
      event.stopPropagation();
      if (active) toggle(active);
    }
  }

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setQuery("");
          setIndex(-1);
        }
        setOpen(next);
      }}
    >
      <PopoverPrimitive.Trigger
        type="button"
        id={id}
        // The label, then the trigger's own text (the picks).
        aria-labelledby={labelledBy && id ? `${labelledBy} ${id}` : labelledBy}
        data-placeholder={summary === null ? "" : undefined}
        className={cn(selectTriggerClass, className)}
      >
        <span>
          <span className="truncate">{summary ?? placeholder}</span>
        </span>
        <ChevronDownIcon size="sm" className="shrink-0 text-muted-foreground" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className={cn(
            selectContentClass,
            "max-h-[var(--radix-popover-content-available-height)] max-w-[var(--radix-popover-content-available-width)] min-w-[var(--radix-popover-trigger-width)]",
          )}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <div className={cn(selectPanelClass, "gap-1")}>
            <Input
              ref={inputRef}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={activeId}
              aria-label={filterPlaceholder ?? "Filter"}
              className="shrink-0"
              placeholder={filterPlaceholder}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setIndex(event.target.value.trim() ? 0 : -1);
              }}
              onKeyDown={onKeyDown}
            />
            <div
              id={listId}
              role="listbox"
              aria-multiselectable="true"
              aria-labelledby={labelledBy}
              className="max-h-72 min-h-0 overflow-y-auto"
            >
              {shown.length === 0 && (
                <div className="px-2 py-1.5 text-meta text-faint">No matches.</div>
              )}
              {shown.map((option, i) => {
                const picked = value.includes(option.id);
                const extra = trailing?.(option);
                return (
                  <div
                    key={option.id}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={picked}
                    data-highlighted={i === index ? "" : undefined}
                    data-state={picked ? "checked" : "unchecked"}
                    className={selectItemClass}
                    // Keeps focus in the filter.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => i !== index && setIndex(i)}
                    onClick={() => toggle(option)}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {picked && <CheckIcon size="sm" />}
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      {renderOption ? (
                        renderOption(option)
                      ) : (
                        <span className="truncate">{optionText(option)}</span>
                      )}
                    </span>
                    {extra && <span className="ml-4 shrink-0">{extra}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
