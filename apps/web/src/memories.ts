import {
  MAX_MEMORY_CHARS,
  type Memory,
  type MemoryInput,
  type MemoryKind,
} from "@blackwall/shared";
import { parseLines } from "./settings-forms";

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  convention: "Convention",
  pitfall: "Pitfall",
  decision: "Decision",
  command: "Command",
  context: "Context",
};

/** The memory form's fields; `files` holds one repo-relative path per line. */
export interface MemoryDraft {
  kind: MemoryKind;
  text: string;
  files: string;
}

/** A draft of `memory`, or an empty convention for a new note. */
export function memoryDraft(memory?: Memory): MemoryDraft {
  return {
    kind: memory?.kind ?? "convention",
    text: memory?.text ?? "",
    files: memory?.files?.join("\n") ?? "",
  };
}

/** The note to save: trimmed text, and files as non-empty lines or null when none. */
export function draftToMemoryInput(draft: MemoryDraft): MemoryInput {
  const files = parseLines(draft.files);
  return { kind: draft.kind, text: draft.text.trim(), files: files.length > 0 ? files : null };
}

/** Why the draft cannot be saved, or null when it can. */
export function memoryDraftError(draft: MemoryDraft): string | null {
  const text = draft.text.trim();
  if (text === "") return "Write the note";
  if (text.length > MAX_MEMORY_CHARS) return `At most ${MAX_MEMORY_CHARS} characters`;
  return null;
}
