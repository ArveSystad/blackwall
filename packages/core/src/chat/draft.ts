/** JSON escapes that decode to another character; the rest (`\"`, `\\`, `\/`) to themselves. */
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };

/** A string literal's decoded text, and the index after its closing quote (-1: unterminated). */
function readString(json: string, start: number): { value: string; end: number } {
  let value = "";
  let i = start;
  while (i < json.length) {
    const c = json[i];
    if (c === '"') return { value, end: i + 1 };
    if (c !== "\\") {
      value += c;
      i++;
      continue;
    }
    const escape = json[i + 1];
    // An escape that has not fully arrived yet is dropped.
    if (escape === undefined) break;
    if (escape === "u") {
      const hex = json.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      value += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    value += ESCAPES[escape] ?? escape;
    i += 2;
  }
  return { value, end: -1 };
}

/**
 * The string value of `key` in the top-level object of incomplete JSON,
 * decoded up to where the buffer ends. Nested keys never match. Null until the
 * value's opening quote has arrived, or when the value is not a string.
 */
export function partialJsonString(json: string, key: string): string | null {
  let depth = 0;
  let inObject = false;
  let expectKey = false;
  let i = 0;
  while (i < json.length) {
    const c = json[i];
    if (c === '"') {
      const { value, end } = readString(json, i + 1);
      if (end < 0) return null;
      if (depth === 1 && expectKey) {
        expectKey = false;
        if (value === key) {
          let j = end;
          while (j < json.length && /\s/.test(json[j] ?? "")) j++;
          if (json[j] !== ":") return null;
          j++;
          while (j < json.length && /\s/.test(json[j] ?? "")) j++;
          if (json[j] !== '"') return null;
          return readString(json, j + 1).value;
        }
      }
      i = end;
      continue;
    }
    if (c === "{" || c === "[") {
      depth++;
      if (depth === 1) {
        inObject = c === "{";
        expectKey = inObject;
      }
    } else if (c === "}" || c === "]") {
      depth--;
    } else if (c === "," && depth === 1 && inObject) {
      expectKey = true;
    }
    i++;
  }
  return null;
}

/** A line opening or closing a fenced block; a trailing half-written fence counts too. */
const FENCE_LINE = /^ {0,3}```([\w-]*)/;
const PARTIAL_FENCE = /^ {0,3}`{1,2}$/;
const CLOSING_FENCE = /^ {0,3}```\s*$/;

interface Fence {
  /** Where the opening line starts. */
  start: number;
  lang: string;
  body: string;
}

/** The fenced blocks of `text`, open or closed, in order. */
function fences(text: string): Fence[] {
  const found: Fence[] = [];
  let open: { start: number; lang: string; bodyStart: number } | undefined;
  let offset = 0;
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, "");
    const next = offset + raw.length + 1;
    const last = index === lines.length - 1;
    if (open) {
      if (CLOSING_FENCE.test(line)) {
        found.push({
          start: open.start,
          lang: open.lang,
          body: text.slice(open.bodyStart, offset),
        });
        open = undefined;
      }
    } else {
      const lang = FENCE_LINE.exec(line)?.[1];
      if (lang !== undefined) {
        open = { start: offset, lang: lang.toLowerCase(), bodyStart: Math.min(next, text.length) };
      } else if (last && PARTIAL_FENCE.test(line)) {
        open = { start: offset, lang: "", bodyStart: text.length };
      }
    }
    offset = next;
  }
  if (open) found.push({ start: open.start, lang: open.lang, body: text.slice(open.bodyStart) });
  return found;
}

/**
 * The chat reply as streamed so far, from a `partial` event; null when there
 * is none yet. Structured-output JSON (`json`) yields its `reply` string.
 * Prose (Copilot) yields itself, up to its first fence: any fence opening, of
 * any language or none, cuts it. Once the last ```json fence, open or closed,
 * holds a non-empty partial `reply`, that reply is the draft instead.
 *
 * This is deliberately simpler than `parseStructuredOutput`: the draft may run
 * ahead of or contradict the answer it finally picks (an example ```json
 * block with a `reply`, a reply only in an unlabelled fence). The draft is a
 * preview; the validated final reply is authoritative.
 */
export function draftReply({ text, json }: { text: string; json: boolean }): string | null {
  if (json) return partialJsonString(text, "reply") || null;
  const blocks = fences(text);
  if (blocks.length === 0) return text.trim() || null;
  const block = blocks.findLast((b) => b.lang === "json");
  const reply = block ? partialJsonString(block.body, "reply") : null;
  if (reply) return reply;
  return text.slice(0, blocks[0]?.start ?? text.length).trim() || null;
}
