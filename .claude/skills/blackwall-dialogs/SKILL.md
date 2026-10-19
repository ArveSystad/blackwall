---
name: blackwall-dialogs
description: >
  How to build dialogs in apps/web: confirm dialogs, confirmations ("are you sure"), delete/remove/
  discard confirmations, destructive actions, push/send confirmations, modals, forms in a dialog and
  edit dialogs. Covers ConfirmDialog vs ui/dialog.tsx, layout, keys, errors, credentials, cache
  updates and copy. Use for ANY dialog or modal work in apps/web, e.g. "add a confirm dialog for
  removing a repo" or "put this form in a modal".
---

# blackwall dialogs

Dialogs are where the user says yes to something that loses data or crosses the wall. Reuse the
existing `ConfirmDialog` and `ui/dialog.tsx` patterns; never hand-roll a modal.

## Communication style

Follow the `caveman` skill for narration and status updates. Code, UI copy and commit text stay normal prose.

## Sources of truth

1. **Visual rules** (tokens, chamfered corners, magenta/violet semantics, the general keyboard map): follow
   `.claude/skills/blackwall-design/SKILL.md`. This skill only adds what is specific to dialogs.
2. **Code** wins over this skill and over task text. References:
   - `apps/web/src/components/ConfirmDialog.tsx`: every yes/no question.
   - `apps/web/src/components/task/DeleteTaskDialog.tsx`: canonical destructive confirm.
   - `apps/web/src/routes/Backlog.tsx`: delete item, and push (`confirmVariant="default"`, `onCloseAutoFocus`).
   - `apps/web/src/components/NewTaskModal.tsx`: canonical form in a dialog.
   - `apps/web/src/components/MissingTokenModal.tsx`: credential prompt.
   - `apps/web/src/components/ui/dialog.tsx`: `Dialog`, `DialogContent`, `DialogTitle`, `DialogDescription`, `DialogFooter`.
   - `apps/web/src/components/task/use-task-action.ts`: credential-cancel mapping.

## Procedure

1. Read `blackwall-design` and the references above.
2. Yes/no question: use `ConfirmDialog`. Form: use `ui/dialog.tsx` directly.
3. Put the API call in `onConfirm` or the submit handler. If it is outbound or credentialed, wrap it
   in `withCredential` and map `MissingCredentialError` (from `api.ts`): in `onConfirm`, rethrow as
   `new Error("Cancelled: no token saved")`; in forms, set the error text.
4. Update the cache (see Cache).
5. Write the copy (see Copy).
6. Handle keys and focus. Use `onCloseAutoFocus` when the trigger disappears after success, as the
   Backlog push does.
7. Run `pnpm typecheck` and `pnpm lint`. Then in the browser try Esc, the overlay, Enter, ⌘↵ and a
   failure path.

## Rules

### ConfirmDialog

- Props: `title`, `children` (the description), `confirmLabel`, `onConfirm: () => Promise<unknown>`,
  `onClose`, `confirmVariant`, `onCloseAutoFocus`.
- `confirmVariant` defaults to `"destructive"`. Use `"default"` for outbound actions that can be
  undone, like the Backlog push (`routes/Backlog.tsx:968-985`).
- While pending the button shows "Working…". If `onConfirm` rejects, it shows `errorMessage(cause)`
  (the error's `.message`) in `ErrorText` and stays open. It closes only when `onConfirm` resolves.
- It is always open, so render it conditionally: `{state && <ConfirmDialog …/>}`.

### Forms

Use `ui/dialog.tsx` the way `NewTaskModal` does: `<Dialog open onOpenChange={(next) => !next && onClose()}>`,
then `DialogContent` holding a `<form onSubmit>`. Always include a `DialogDescription` for
accessibility; add `sr-only` if it isn't visible.

### Layout

- Confirm dialogs: `DialogContent className="max-w-[420px]"`, body `flex flex-col gap-2 px-5 pt-[18px] pb-4`.
- Default content max width is 480. `NewTaskModal` uses 680; wider forms are fine.
- `DialogFooter` is right-aligned: Cancel (`variant="ghost"`) first, then the primary
  (`variant="primary"`) or destructive button last.
- Key hints: `<Kbd aria-hidden="true">↵</Kbd>` on the confirm button;
  `<Kbd onFill aria-hidden="true">{modKeyLabel("↵")}</Kbd>` on a filled form-submit button.

### Keys

Helpers live in `apps/web/src/keyboard.ts`: `useWindowKeydown`, `isModKey`, `isPlainKey`,
`isTypingTarget`, `modKeyLabel`.

- Esc and an overlay click close the dialog through `onOpenChange`. Never add a separate Esc handler.
- Enter confirms because the confirm button has `autoFocus`.
- ⌘/Ctrl+Enter submits forms through the form's `onKeyDown` with `isModKey(event.nativeEvent)`, as
  `NewTaskModal` does. Not through `useWindowKeydown`, so it also works inside textareas.
- `useWindowKeydown` is only for plain-key shortcuts inside the dialog, like the `NewTaskModal` 1–4
  origin keys. Guard with `isPlainKey(event)` and `!isTypingTarget(event.target)`.

### Errors and credentials

- Use `errorMessage` from `apps/web/src/settings-forms.ts` and `ErrorText` from
  `apps/web/src/components/ui/field.tsx`. In forms, show the error in the footer's left slot in
  place of the hint, as `NewTaskModal` does.
- Wrap outbound or credentialed calls in `useWithCredential()` from `apps/web/src/credentials.ts`:
  `withCredential({ label, target }, () => api(...))`. When a token is missing, `CredentialProvider`
  opens `MissingTokenModal`. If the user cancels, the call rejects with `MissingCredentialError`.
  Import it from `apps/web/src/api.ts`; `credentials.ts` does not export it.
- **Forms and handlers** (existing pattern):
  `cause instanceof MissingCredentialError ? "Cancelled: no token saved" : errorMessage(cause)`.
  See `task/use-task-action.ts:29-34`, `NewTaskModal.tsx:518`/`550`, `settings/ConnectionsSection.tsx:61-76`.
- **Inside `ConfirmDialog.onConfirm`** (new pattern; no existing caller yet). `ConfirmDialog` does
  not wrap or map anything itself, so call `withCredential` in `onConfirm` and rethrow:
  ```ts
  try {
    await withCredential(...);
  } catch (cause) {
    throw cause instanceof MissingCredentialError
      ? new Error("Cancelled: no token saved")
      : cause;
  }
  ```
  Rethrow, never swallow, so the dialog stays open and shows the message. The Backlog push calls
  `pushRepo` directly without `withCredential`; do not copy it as a credential example.

### Cache

After the mutation succeeds, update TanStack Query inside `onConfirm` or the submit handler:
- `forgetTask(queryClient, id)` from `apps/web/src/live.ts`, as `DeleteTaskDialog` does;
- `setQueryData` when the result is known;
- `invalidateQueries({ queryKey: queryKeys.… })`, as the Backlog delete does (`routes/Backlog.tsx:957-960`).

### Copy

- Title and confirm label are verb + object ("Delete task", "Remove repo"), never "OK" or "Yes".
- The body says what is lost and what stays ("the folder on disk is not touched").
- Name exact things in mono, like the branch in `DeleteTaskDialog`.
- No exclamation marks.
- Never display tokens; show only whether one is configured or missing.

## Checks

- `pnpm typecheck` and `pnpm lint` pass.
- Esc and the overlay close; Enter confirms; ⌘↵ submits forms, including from a textarea.
- A failed call keeps the dialog open with the error; cancelling a token prompt shows
  "Cancelled: no token saved".
- The cache reflects the change without a reload.

## Changing this skill

When a dialog pattern changes, update this skill in the same commit so it never contradicts the code.
