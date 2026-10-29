import { MAX_MEMORY_CHARS, type Memory } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { draftToMemoryInput, memoryDraft, memoryDraftError } from "./memories";

const memory: Memory = {
  id: "m1",
  repoId: "r1",
  sourceTaskId: "t1",
  kind: "command",
  text: "pnpm db:generate",
  files: ["drizzle.config.ts", "src/db/schema.ts"],
  pinned: false,
  awaitingMerge: false,
  editedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("memoryDraft", () => {
  it("starts a new note as an empty convention", () => {
    expect(memoryDraft()).toEqual({ kind: "convention", text: "", files: "" });
  });

  it("round-trips a memory", () => {
    const draft = memoryDraft(memory);
    expect(draft.files).toBe("drizzle.config.ts\nsrc/db/schema.ts");
    expect(draftToMemoryInput(draft)).toEqual({
      kind: "command",
      text: "pnpm db:generate",
      files: ["drizzle.config.ts", "src/db/schema.ts"],
    });
  });
});

describe("draftToMemoryInput", () => {
  it("trims the text and file lines and drops blank lines", () => {
    expect(
      draftToMemoryInput({
        kind: "pitfall",
        text: "  Run codegen ",
        files: " a.ts \r\n\n  b.ts\n ",
      }),
    ).toEqual({ kind: "pitfall", text: "Run codegen", files: ["a.ts", "b.ts"] });
  });

  it("gives null files when none are listed", () => {
    expect(draftToMemoryInput({ kind: "context", text: "x", files: " \n " }).files).toBeNull();
  });
});

describe("memoryDraftError", () => {
  const draft = (text: string) => ({ kind: "context" as const, text, files: "" });

  it("asks for the note when empty", () => {
    expect(memoryDraftError(draft("   "))).toBe("Write the note");
  });

  it("caps the length", () => {
    expect(memoryDraftError(draft("x".repeat(MAX_MEMORY_CHARS + 1)))).toBe(
      "At most 500 characters",
    );
    expect(memoryDraftError(draft(` ${"x".repeat(MAX_MEMORY_CHARS)} `))).toBeNull();
  });
});
