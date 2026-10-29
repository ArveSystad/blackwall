import { DATA_IMPORT_TABLES, type DataImportResult } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { conflictReason, importSummary } from "./data-import";

function counts(
  values: Partial<Record<keyof DataImportResult["counts"], [number, number]>>,
): DataImportResult["counts"] {
  return Object.fromEntries(
    DATA_IMPORT_TABLES.map((t) => {
      const [imported, skipped] = values[t] ?? [0, 0];
      return [t, { imported, skipped }];
    }),
  ) as DataImportResult["counts"];
}

describe("importSummary", () => {
  it("lists imported rows in order with plurals and an and", () => {
    expect(importSummary(counts({ memories: [8, 0], tasks: [12, 100], runs: [30, 40] }))).toBe(
      "Imported 12 tasks, 30 runs and 8 memories; skipped 140 existing rows.",
    );
  });

  it("uses singulars and joins two parts with and", () => {
    expect(importSummary(counts({ tasks: [1, 0], repos: [1, 1] }))).toBe(
      "Imported 1 task and 1 repository; skipped 1 existing row.",
    );
  });

  it("names a single imported table on its own", () => {
    expect(importSummary(counts({ backlogItems: [2, 0] }))).toBe(
      "Imported 2 backlog items; skipped 0 existing rows.",
    );
  });

  it("says when nothing was new", () => {
    expect(importSummary(counts({ tasks: [0, 3], stepEvents: [0, 9] }))).toBe(
      "Nothing new to import; skipped 12 existing rows.",
    );
    expect(importSummary(counts({}))).toBe("Nothing new to import; skipped 0 existing rows.");
  });
});

describe("conflictReason", () => {
  it("explains both conflict kinds", () => {
    expect(conflictReason({ kind: "different-path" })).toBe("Same remote, different folder");
    expect(conflictReason({ kind: "different-remote" })).toBe("Same folder, different remote");
  });
});
