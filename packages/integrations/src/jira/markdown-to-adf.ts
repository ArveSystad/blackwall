import type { AdfDoc, AdfMark, AdfNode } from "./adf.js";

// Inline syntax, tried in this order at each position; the earliest match wins.
const INLINE: { pattern: RegExp; build: (m: RegExpExecArray, marks: AdfMark[]) => AdfNode[] }[] = [
  {
    pattern: /`([^`]+)`/,
    build: (m, marks) => [text(m[1]!, [...marks, { type: "code" }])],
  },
  {
    pattern: /\[([^\]]+)\]\(([^)\s]+)\)/,
    build: (m, marks) => parseInline(m[1]!, [...marks, link(m[2]!)]),
  },
  {
    pattern: /<(https?:\/\/[^>\s]+)>/,
    build: (m, marks) => [text(m[1]!, [...marks, link(m[1]!)])],
  },
  {
    pattern: /\*\*(.+?)\*\*|__(.+?)__/,
    build: (m, marks) => parseInline(m[1] ?? m[2]!, [...marks, { type: "strong" }]),
  },
  {
    pattern: /~~(.+?)~~/,
    build: (m, marks) => parseInline(m[1]!, [...marks, { type: "strike" }]),
  },
  {
    pattern: /\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])/,
    build: (m, marks) => parseInline(m[1] ?? m[2]!, [...marks, { type: "em" }]),
  },
  {
    pattern: /https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/,
    build: (m, marks) => [text(m[0], [...marks, link(m[0])])],
  },
];

function link(href: string): AdfMark {
  return { type: "link", attrs: { href } };
}

function text(value: string, marks: AdfMark[]): AdfNode {
  return marks.length > 0 ? { type: "text", text: value, marks } : { type: "text", text: value };
}

function parseInline(source: string, marks: AdfMark[] = []): AdfNode[] {
  const nodes: AdfNode[] = [];
  let rest = source;
  while (rest) {
    let best: { index: number; match: RegExpExecArray; rule: (typeof INLINE)[number] } | undefined;
    for (const rule of INLINE) {
      const match = rule.pattern.exec(rest);
      if (match && (!best || match.index < best.index)) best = { index: match.index, match, rule };
    }
    if (!best) {
      nodes.push(text(rest, marks));
      break;
    }
    if (best.index > 0) nodes.push(text(rest.slice(0, best.index), marks));
    nodes.push(...best.rule.build(best.match, marks));
    rest = rest.slice(best.index + best.match[0].length);
  }
  return nodes;
}

/** Inline content of a paragraph: its lines kept apart with hard breaks. */
function paragraphContent(lines: readonly string[]): AdfNode[] {
  const content: AdfNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: "hardBreak" });
    content.push(...parseInline(line.trim()));
  });
  return content;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST_ITEM = /^( *)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line)
  );
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function tableRow(cells: string[], cellType: "tableHeader" | "tableCell", width: number): AdfNode {
  return {
    type: "tableRow",
    content: Array.from({ length: width }, (_, i) => ({
      type: cellType,
      content: [{ type: "paragraph", content: parseInline(cells[i] ?? "") }],
    })),
  };
}

/** Parses a run of list lines (all at or deeper than the first item's indent). */
function parseList(lines: string[], start: number): { node: AdfNode; next: number } {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const baseIndent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: AdfNode[] = [];
  let i = start;
  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]!);
    if (!match || match[1]!.length !== baseIndent || /\d/.test(match[2]!) !== ordered) break;
    // The item's own lines: its text plus deeper-indented continuation lines.
    const body = [match[3]!];
    i++;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.trim() === "") {
        const nextLine = lines[i + 1];
        const continues =
          nextLine !== undefined && nextLine.length - nextLine.trimStart().length > baseIndent;
        if (!continues) break;
        body.push("");
        i++;
        continue;
      }
      const indentLen = line.length - line.trimStart().length;
      if (indentLen <= baseIndent) break;
      body.push(line.slice(Math.min(indentLen, baseIndent + 2)));
      i++;
    }
    items.push({ type: "listItem", content: parseBlocks(body) });
  }
  const node: AdfNode = ordered
    ? {
        type: "orderedList",
        attrs: { order: Number.parseInt(first[2]!, 10) || 1 },
        content: items,
      }
    : { type: "bulletList", content: items };
  return { node, next: i };
}

function parseBlocks(lines: string[]): AdfNode[] {
  const nodes: AdfNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(marker)) code.push(lines[i++]!);
      i++; // closing fence
      const node: AdfNode = { type: "codeBlock" };
      if (fence[2]) node.attrs = { language: fence[2] };
      if (code.length > 0) node.content = [{ type: "text", text: code.join("\n") }];
      nodes.push(node);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      nodes.push({
        type: "heading",
        attrs: { level: heading[1]!.length },
        content: parseInline(heading[2]!),
      });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      nodes.push({ type: "rule" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(lines[i++]!.replace(QUOTE, ""));
      nodes.push({ type: "blockquote", content: parseBlocks(quoted) });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const { node, next } = parseList(lines, i);
      nodes.push(node);
      i = next;
      continue;
    }

    if (line.includes("|") && TABLE_SEPARATOR.test(lines[i + 1] ?? "")) {
      const header = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(tableCells(lines[i++]!));
      }
      const width = header.length;
      nodes.push({
        type: "table",
        attrs: { isNumberColumnEnabled: false, layout: "default" },
        content: [
          tableRow(header, "tableHeader", width),
          ...rows.map((r) => tableRow(r, "tableCell", width)),
        ],
      });
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      (paragraph.length === 0 || !isBlockStart(lines[i]!))
    ) {
      paragraph.push(lines[i++]!);
    }
    nodes.push({ type: "paragraph", content: paragraphContent(paragraph) });
  }
  return nodes;
}

/**
 * Converts markdown (as agents write it) to an ADF document for posting to
 * Jira: headings, paragraphs, nested lists, fenced code, quotes, rules, GFM
 * tables and inline bold/italic/strike/code/links. Line breaks inside a
 * paragraph are kept as hard breaks.
 */
export function markdownToAdf(markdown: string): AdfDoc {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  return { type: "doc", version: 1, content: parseBlocks(lines) };
}
