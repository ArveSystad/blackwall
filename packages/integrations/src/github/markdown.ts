/** Markdown helpers shared by the pull request and issue renderers. */

export const author = (user: { login: string } | null | undefined) => user?.login ?? "unknown";

export function byCreated<T extends { created: string | null }>(a: T, b: T): number {
  return (a.created ?? "").localeCompare(b.created ?? "");
}

/** Pushes markdown headings down so they sit below a section at `level`. */
export function demote(markdown: string, level: number): string {
  // Keep the PR's or issue's own headings below the section they appear in.
  const prefix = "#".repeat(level - 1);
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      return !fenced && /^#{1,6}\s/.test(line) ? `${prefix}${line}` : line;
    })
    .join("\n");
}

/** A fenced block that survives backtick fences inside `text`. */
export function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${text.replace(/\n$/, "")}\n${ticks}`;
}

/** A `###` section, or nothing when the body is empty. */
export function sectionOf(title: string, body: string): string {
  return body.trim() ? `### ${title}\n\n${body}` : "";
}

export const day = (iso: string | null) => (iso ? ` (${iso.slice(0, 10)})` : "");
