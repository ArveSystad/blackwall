/** Largest ```svg fence, in UTF-8 bytes, that chat shows as an illustration. */
export const MAX_SVG_BYTES = 100_000;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Null when `source` is not a single well-formed `<svg>` document. */
export type SvgCheck = (source: string) => { title: string | null } | null;

/** Parses with the browser's XML parser; null without one (tests, SSR), so the code block shows. */
export const parseSvg: SvgCheck = (source) => {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = doc.documentElement;
  // Chrome nests <parsererror> inside the root on errors; Firefox makes it the root.
  if (root.localName !== "svg" || root.namespaceURI !== SVG_NS) return null;
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  const title = Array.from(root.children).find((child) => child.localName === "title");
  return { title: title?.textContent?.trim() || null };
};

/** The illustration a fenced block stands for, or null to keep it as code. */
export function svgIllustration(
  language: string | undefined,
  source: string,
  check: SvgCheck = parseSvg,
): { source: string; alt: string } | null {
  if (language !== "svg") return null;
  const trimmed = source.trim();
  if (trimmed === "") return null;
  if (new TextEncoder().encode(source).length > MAX_SVG_BYTES) return null;
  const parsed = check(trimmed);
  if (!parsed) return null;
  return { source: trimmed, alt: parsed.title ?? "Illustration" };
}

/** An `<img>`-loadable URL for an svg source. Images never run script or fetch subresources. */
export function svgDataUrl(source: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
}

/** `x` from a hast `language-x` class list. */
export function codeLanguage(className: unknown): string | undefined {
  const classes = Array.isArray(className)
    ? className
    : typeof className === "string"
      ? className.split(" ")
      : [];
  for (const name of classes) {
    if (typeof name === "string" && name.startsWith("language-")) {
      return name.slice("language-".length);
    }
  }
  return undefined;
}
