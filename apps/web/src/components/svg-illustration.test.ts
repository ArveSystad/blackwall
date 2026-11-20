import { describe, expect, it, vi } from "vitest";
import {
  codeLanguage,
  svgDataUrl,
  MAX_SVG_BYTES,
  parseSvg,
  svgIllustration,
} from "./svg-illustration";

const valid = () => ({ title: null });
const svg = "<svg viewBox='0 0 1 1'/>";

describe("svgIllustration", () => {
  it("shows a well-formed svg fence with a default alt", () => {
    expect(svgIllustration("svg", svg, valid)).toEqual({ source: svg, alt: "Illustration" });
  });

  it("uses the title as alt and trims the source", () => {
    expect(svgIllustration("svg", `\n  ${svg}\n`, () => ({ title: "Login" }))).toEqual({
      source: svg,
      alt: "Login",
    });
  });

  it("keeps other languages as code", () => {
    expect(svgIllustration("xml", svg, valid)).toBeNull();
    expect(svgIllustration(undefined, svg, valid)).toBeNull();
  });

  it("keeps malformed svg as code", () => {
    expect(svgIllustration("svg", "<svg", () => null)).toBeNull();
  });

  it("keeps empty fences as code", () => {
    expect(svgIllustration("svg", "", valid)).toBeNull();
    expect(svgIllustration("svg", "  \n ", valid)).toBeNull();
  });

  it("keeps oversized svg as code without parsing it", () => {
    const check = vi.fn(valid);
    expect(svgIllustration("svg", "a".repeat(MAX_SVG_BYTES + 1), check)).toBeNull();
    expect(check).not.toHaveBeenCalled();
    expect(svgIllustration("svg", "a".repeat(MAX_SVG_BYTES), check)).not.toBeNull();
  });

  it("counts bytes, not characters", () => {
    const source = "é".repeat(MAX_SVG_BYTES / 2 + 1);
    expect(source.length).toBeLessThan(MAX_SVG_BYTES);
    expect(svgIllustration("svg", source, valid)).toBeNull();
  });
});

describe("parseSvg", () => {
  it("returns null without a DOMParser", () => {
    expect(typeof DOMParser).toBe("undefined");
    expect(parseSvg(svg)).toBeNull();
  });
});

describe("codeLanguage", () => {
  it("reads the language class", () => {
    expect(codeLanguage(["language-svg"])).toBe("svg");
    expect(codeLanguage(undefined)).toBeUndefined();
    expect(codeLanguage(["foo"])).toBeUndefined();
  });
});

describe("svgDataUrl", () => {
  it("encodes the source into an image data URL", () => {
    expect(svgDataUrl("<svg a='#'/>")).toBe(
      "data:image/svg+xml;charset=utf-8,%3Csvg%20a%3D'%23'%2F%3E",
    );
  });
});
