import { describe, expect, it } from "vitest";
import { DARK_CANVAS, LIGHT_CANVAS, TITLE_BAR_HEIGHT, titleBarOverlay } from "./title-bar.js";

describe("titleBarOverlay", () => {
  it("is dark without a page colour", () => {
    expect(titleBarOverlay(null)).toEqual({
      color: DARK_CANVAS,
      symbolColor: "#ebe8f7",
      height: TITLE_BAR_HEIGHT,
    });
  });

  it("uses light symbols on the dark canvas", () => {
    expect(titleBarOverlay("#0a0918")).toEqual({
      color: "#0a0918",
      symbolColor: "#ebe8f7",
      height: TITLE_BAR_HEIGHT,
    });
  });

  it("uses dark symbols on the light canvas", () => {
    expect(titleBarOverlay(LIGHT_CANVAS)).toEqual({
      color: LIGHT_CANVAS,
      symbolColor: "#111118",
      height: TITLE_BAR_HEIGHT,
    });
  });

  it("accepts uppercase hex", () => {
    expect(titleBarOverlay("#F3F3F6")).toEqual({
      color: "#F3F3F6",
      symbolColor: "#111118",
      height: TITLE_BAR_HEIGHT,
    });
  });

  it("falls back to dark for anything but #rrggbb", () => {
    for (const value of ["red", "#fff", ""]) {
      expect(titleBarOverlay(value)).toEqual(titleBarOverlay(null));
    }
  });

  it("always uses the fixed height", () => {
    for (const value of [null, "#0a0918", "#ffffff", "nope"]) {
      expect(titleBarOverlay(value).height).toBe(TITLE_BAR_HEIGHT);
    }
  });
});
