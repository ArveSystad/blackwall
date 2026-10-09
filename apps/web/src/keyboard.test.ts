import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTypingTarget } from "./keyboard";

/** Fake element; the web tests run without a DOM. `inside` lists the roles of its ancestors (or itself). */
function element(tagName: string, { inside = [] as string[], editable = false } = {}) {
  return Object.assign(Object.create(HTMLElement.prototype) as HTMLElement, {
    tagName,
    isContentEditable: editable,
    closest: (selector: string) =>
      inside.some((role) => selector.includes(`[role=${role}]`)) ? {} : null,
  });
}

describe("isTypingTarget", () => {
  beforeEach(() => vi.stubGlobal("HTMLElement", class {}));
  afterEach(() => vi.unstubAllGlobals());

  it("is false for no target or a non-element", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({} as EventTarget)).toBe(false);
  });

  it("is true for text fields, native selects and contentEditable", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(isTypingTarget(element(tag))).toBe(true);
    }
    expect(isTypingTarget(element("DIV", { editable: true }))).toBe(true);
  });

  it("is true inside a select menu's trigger or open list", () => {
    expect(isTypingTarget(element("BUTTON", { inside: ["combobox"] }))).toBe(true);
    expect(isTypingTarget(element("DIV", { inside: ["option", "listbox"] }))).toBe(true);
  });

  it("is false for other elements", () => {
    expect(isTypingTarget(element("BUTTON"))).toBe(false);
    expect(isTypingTarget(element("DIV", { inside: ["dialog"] }))).toBe(false);
  });
});
