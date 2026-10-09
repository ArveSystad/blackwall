import { createContext, useContext } from "react";

/** The control id and hint id a `Field` hands to the one control inside it. */
export const FieldContext = createContext<{ id: string; describedBy?: string | undefined } | null>(
  null,
);

/** `id` and `aria-describedby` for a control inside a `Field`; nothing outside one. */
export function useFieldControl(): { id?: string; "aria-describedby"?: string } {
  const field = useContext(FieldContext);
  if (!field) return {};
  return field.describedBy
    ? { id: field.id, "aria-describedby": field.describedBy }
    : { id: field.id };
}
