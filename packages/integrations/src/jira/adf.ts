/**
 * Atlassian Document Format: the JSON tree Jira Cloud REST v3 uses for
 * descriptions and comments. Only the fields blackwall reads are typed.
 */
export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

export interface AdfDoc extends AdfNode {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

function attr(node: AdfNode | AdfMark, name: string): string | undefined {
  const value = node.attrs?.[name];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function applyMarks(text: string, marks: readonly AdfMark[] = []): string {
  if (!text) return text;
  const code = marks.some((m) => m.type === "code");
  let out = code ? `\`${text}\`` : text;
  for (const mark of marks) {
    switch (mark.type) {
      case "strong":
        out = `**${out}**`;
        break;
      case "em":
        out = `*${out}*`;
        break;
      case "strike":
        out = `~~${out}~~`;
        break;
    }
  }
  const href = marks.find((m) => m.type === "link");
  const url = href && attr(href, "href");
  return url ? `[${out}](${url})` : out;
}

function inline(nodes: readonly AdfNode[] = []): string {
  return nodes.map(inlineNode).join("");
}

function inlineNode(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return applyMarks(node.text ?? "", node.marks);
    case "hardBreak":
      return "\n";
    case "mention":
      return attr(node, "text") ?? "@someone";
    case "emoji":
      return attr(node, "text") ?? attr(node, "shortName") ?? "";
    case "inlineCard":
    case "blockCard":
    case "embedCard": {
      const url = attr(node, "url");
      return url ? `<${url}>` : "";
    }
    case "date": {
      const ms = Number(attr(node, "timestamp"));
      return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
    }
    case "status":
      return `[${attr(node, "text") ?? ""}]`;
    case "media":
    case "mediaInline":
      return `[attachment: ${attr(node, "alt") ?? attr(node, "id") ?? "file"}]`;
    case "placeholder":
      return "";
    default:
      return inline(node.content);
  }
}

function indent(text: string, prefix: string, first = prefix): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? first : line ? prefix : "") + line)
    .join("\n");
}

function list(node: AdfNode, ordered: boolean): string {
  const start = Number(attr(node, "order") ?? 1) || 1;
  return (node.content ?? [])
    .map((item, i) => {
      const marker = ordered ? `${start + i}. ` : "- ";
      const body = blocks(item.content).trim() || " ";
      return indent(body, " ".repeat(marker.length), marker);
    })
    .join("\n");
}

function tableCell(cell: AdfNode): string {
  return blocks(cell.content).trim().replace(/\n+/g, "<br>").replace(/\|/g, "\\|");
}

function table(node: AdfNode): string {
  const rows = (node.content ?? []).map((row) => (row.content ?? []).map(tableCell));
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const [head, ...body] = rows;
  return [line(head ?? []), line(Array(width).fill("---")), ...body.map(line)].join("\n");
}

function block(node: AdfNode): string {
  switch (node.type) {
    case "paragraph":
      return inline(node.content);
    case "heading": {
      const level = Math.min(Math.max(Number(attr(node, "level") ?? 1), 1), 6);
      return `${"#".repeat(level)} ${inline(node.content)}`;
    }
    case "bulletList":
      return list(node, false);
    case "orderedList":
      return list(node, true);
    case "taskList":
    case "decisionList":
      return (node.content ?? [])
        .map((item) => {
          const done = attr(item, "state") === "DONE" || attr(item, "state") === "DECIDED";
          return `- [${done ? "x" : " "}] ${inline(item.content)}`;
        })
        .join("\n");
    case "codeBlock": {
      const code = (node.content ?? []).map((n) => n.text ?? "").join("");
      const fence = code.includes("```") ? "~~~" : "```";
      return `${fence}${attr(node, "language") ?? ""}\n${code}\n${fence}`;
    }
    case "blockquote":
      return indent(blocks(node.content), "> ").replace(/^$/gm, ">");
    case "panel": {
      const kind = attr(node, "panelType") ?? "info";
      const body = blocks(node.content);
      return indent(`**${kind[0]?.toUpperCase()}${kind.slice(1)}:** ${body}`, "> ").replace(
        /^$/gm,
        ">",
      );
    }
    case "expand":
    case "nestedExpand": {
      const title = attr(node, "title");
      return [title ? `**${title}**` : "", blocks(node.content)].filter(Boolean).join("\n\n");
    }
    case "rule":
      return "---";
    case "table":
      return table(node);
    case "mediaSingle":
    case "mediaGroup":
      return (node.content ?? []).map(inlineNode).join("\n");
    case "extension":
    case "bodiedExtension":
    case "inlineExtension":
      return "";
    default:
      // Unknown block: keep its text rather than lose it.
      return node.content ? blocks(node.content) : inlineNode(node);
  }
}

function blocks(nodes: readonly AdfNode[] = []): string {
  return nodes
    .map(block)
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}

/**
 * Renders an ADF document (or a plain string from an older API) as markdown.
 * Unknown nodes keep their text; extensions are dropped.
 */
export function adfToMarkdown(doc: AdfNode | string | null | undefined): string {
  if (doc == null) return "";
  if (typeof doc === "string") return doc.trim();
  return (doc.type === "doc" ? blocks(doc.content) : block(doc)).trim();
}
