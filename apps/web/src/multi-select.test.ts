import { describe, expect, it } from "vitest";
import { filterOptions, selectionSummary } from "./multi-select";

describe("filterOptions", () => {
  const options = [{ name: "Blackwall" }, { name: "api-gateway" }, { name: "Web App" }];
  const text = (o: { name: string }) => o.name;

  it("keeps every option for an empty or blank query", () => {
    expect(filterOptions(options, "", text)).toEqual(options);
    expect(filterOptions(options, "   ", text)).toEqual(options);
  });

  it("matches anywhere in the text, ignoring case and surrounding spaces", () => {
    expect(filterOptions(options, " WALL ", text)).toEqual([{ name: "Blackwall" }]);
    expect(filterOptions(options, "a", text)).toEqual(options);
    expect(filterOptions(options, "app", text)).toEqual([{ name: "Web App" }]);
  });

  it("returns nothing when no option matches", () => {
    expect(filterOptions(options, "zzz", text)).toEqual([]);
  });
});

describe("selectionSummary", () => {
  it("is null with nothing picked", () => {
    expect(selectionSummary([])).toBeNull();
  });

  it("joins one or two labels", () => {
    expect(selectionSummary(["a"])).toBe("a");
    expect(selectionSummary(["a", "b"])).toBe("a, b");
  });

  it("shows the first label and a count past two", () => {
    expect(selectionSummary(["a", "b", "c"])).toBe("a +2");
    expect(selectionSummary(["a", "b", "c", "d"])).toBe("a +3");
  });
});
