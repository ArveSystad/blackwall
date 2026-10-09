// Class groups shared by several panes. Full literal strings, so Tailwind finds them.

/** A pane's title row. */
export const paneHeader = "flex min-h-[52px] items-center gap-2.5 border-b border-border px-5 py-3";

/** The heading inside `paneHeader`. */
export const paneTitle = "m-0 truncate text-heading font-semibold text-foreground-strong";

/** A pane's scrolling list body. */
export const paneBody = "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4";

/** A settings editor's scrolling form body. */
export const editorBody = "flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto px-5 py-[18px]";

/** The list column on the left of a list and editor split. */
export const listPane = "flex w-[360px] shrink-0 flex-col border-r border-border";

/** The scrolling list inside `listPane`. */
export const sideList = "m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-auto p-1.5";

/** A row in `sideList`; add `rowSelected` for the open one. */
export const rowSelectable = "rounded-lg border border-transparent hover:bg-card";

/** The selected row in `sideList`. */
export const rowSelected = "border-border-strong bg-muted hover:bg-muted";

/** A settings fieldset's legend. */
export const sectionLegend = "label mb-1 p-0 text-muted-foreground";

/** A block of code or a suggested fix. */
export const codeBlock =
  "m-0 overflow-x-auto rounded-md border border-border bg-code px-3 py-2 font-mono text-code text-foreground";

/** A task panel's placeholder or note text. */
export const panelNote = "m-0 px-5 py-4 text-muted-foreground";
