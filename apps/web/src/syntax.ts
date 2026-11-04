import type { Root, RootContent } from "hast";
import bash from "highlight.js/lib/languages/bash";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";
import type { DiffLine } from "./task-view";

const lowlight = createLowlight({
  bash,
  csharp,
  css,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  powershell,
  python,
  rust,
  scss,
  sql,
  typescript,
  xml,
  yaml,
});

/** Files longer than this render plain, so the view stays fast. */
export const MAX_HIGHLIGHT_LINES = 5000;

/** A run of text on one line and its highlight.js classes (null for plain text). */
export interface SyntaxToken {
  text: string;
  className: string | null;
}

const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
};

const BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  cs: "csharp",
  json: "json",
  jsonc: "json",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  csproj: "xml",
  props: "xml",
  targets: "xml",
  xaml: "xml",
  resx: "xml",
  config: "xml",
  svg: "xml",
  html: "xml",
  htm: "xml",
  rs: "rust",
  css: "css",
  scss: "scss",
  md: "markdown",
  markdown: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  py: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  sql: "sql",
  toml: "ini",
  ini: "ini",
  dockerfile: "dockerfile",
};

/** The registered grammar for a path, by file name then extension; null when unknown. */
export function languageFor(path: string): string | null {
  const name = (path.split("/").at(-1) ?? "").toLowerCase();
  const byName = BY_NAME[name];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

/**
 * Syntax tokens for each of a file's lines, aligned by index. Context and
 * added lines are highlighted as the new file, deleted lines as the old one,
 * so block comments and multi-line strings carry across lines. Null (plain)
 * for unknown file types, very long files or a grammar that throws.
 */
export function highlightLines(lines: readonly DiffLine[], path: string): SyntaxToken[][] | null {
  const language = languageFor(path);
  if (language === null || lines.length > MAX_HIGHLIGHT_LINES) return null;
  try {
    const newDoc = documentTokens(
      language,
      lines.filter((line) => line.kind === "ctx" || line.kind === "add"),
    );
    const oldDoc = documentTokens(
      language,
      lines.filter((line) => line.kind === "ctx" || line.kind === "del"),
    );
    let newIndex = 0;
    let oldIndex = 0;
    return lines.map((line) => {
      switch (line.kind) {
        case "ctx":
          oldIndex++;
          return newDoc[newIndex++] ?? [];
        case "add":
          return newDoc[newIndex++] ?? [];
        case "del":
          return oldDoc[oldIndex++] ?? [];
        default:
          return [{ text: line.text, className: null }];
      }
    });
  } catch {
    return null;
  }
}

/** Highlights the lines as one document and splits the tokens back into lines. */
function documentTokens(language: string, lines: readonly DiffLine[]): SyntaxToken[][] {
  const tree = lowlight.highlight(language, lines.map((line) => line.text).join("\n"));
  const out: SyntaxToken[][] = [[]];
  flatten(tree, [], out);
  return out;
}

function flatten(node: Root | RootContent, classes: readonly string[], out: SyntaxToken[][]): void {
  if (node.type === "text") {
    const parts = node.value.split("\n");
    const className = classes.length > 0 ? classes.join(" ") : null;
    parts.forEach((text, i) => {
      if (i > 0) out.push([]);
      if (text !== "") out.at(-1)!.push({ text, className });
    });
    return;
  }
  if (node.type !== "root" && node.type !== "element") return;
  const own = node.type === "element" ? classNames(node.properties.className) : [];
  const nested = own.length > 0 ? [...classes, ...own] : classes;
  for (const child of node.children) flatten(child, nested, out);
}

function classNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(" ").filter(Boolean);
  return [];
}
