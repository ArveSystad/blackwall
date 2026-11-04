import { describe, expect, it } from "vitest";
import { highlightLines, languageFor, MAX_HIGHLIGHT_LINES, type SyntaxToken } from "./syntax";
import type { DiffLine } from "./task-view";

function ctx(...texts: string[]): DiffLine[] {
  return texts.map((text, i) => ({ kind: "ctx", text, line: i + 1 }));
}

function hasClass(tokens: readonly SyntaxToken[], cls: string, text?: string): boolean {
  return tokens.some(
    (t) =>
      (t.className?.split(" ").includes(cls) ?? false) && (text === undefined || t.text === text),
  );
}

describe("languageFor", () => {
  it.each([
    ["src/a.ts", "typescript"],
    ["x.tsx", "typescript"],
    ["App.cs", "csharp"],
    ["a.yml", "yaml"],
    ["a.yaml", "yaml"],
    ["proj.csproj", "xml"],
    ["lib.rs", "rust"],
    ["Dockerfile", "dockerfile"],
    ["docker/Dockerfile", "dockerfile"],
    ["README", null],
    ["Makefile.unknown", null],
  ])("%s → %s", (path, language) => {
    expect(languageFor(path)).toBe(language);
  });
});

describe("highlightLines", () => {
  it("marks keywords and strings", () => {
    const tokens = highlightLines(ctx('const x = "a";'), "a.ts")!;
    expect(hasClass(tokens[0]!, "hljs-keyword", "const")).toBe(true);
    expect(hasClass(tokens[0]!, "hljs-string")).toBe(true);
  });

  it("reopens a block comment on every line it spans", () => {
    const tokens = highlightLines(ctx("/* one", "two", "three */", "const x = 1;"), "a.ts")!;
    for (const line of tokens.slice(0, 3)) expect(hasClass(line, "hljs-comment")).toBe(true);
    expect(hasClass(tokens[3]!, "hljs-comment")).toBe(false);
  });

  it("takes deleted lines from the old file and added lines from the new one", () => {
    const lines: DiffLine[] = [
      { kind: "ctx", text: "/* start", line: 1 },
      { kind: "del", text: "let a = 1;", line: 2 },
      { kind: "add", text: "end */ const a = 1;", line: 2 },
      { kind: "ctx", text: "a;", line: 3 },
    ];
    const tokens = highlightLines(lines, "a.ts")!;
    // Old file: the comment never closes, so the deleted line is all comment.
    expect(tokens[1]!.every((t) => t.className?.includes("hljs-comment"))).toBe(true);
    // New file: the comment closes on the added line, then `const` is a keyword.
    expect(hasClass(tokens[2]!, "hljs-keyword", "const")).toBe(true);
    expect(tokens.map((line) => line.map((t) => t.text).join(""))).toEqual(
      lines.map((line) => line.text),
    );
  });

  it.each([
    ["a.js", ["function f(a) {", "  return `x${a}`;", "}"]],
    ["a.ts", ["interface A {", "  b: string; // note", "}"]],
    ["App.cs", ["public class A {", '  string B => "c";', "}"]],
    ["a.json", ['{ "a": [1, true, null],', '  "b": "c" }']],
    ["a.yaml", ["a: 1", "b:", "  - 'c' # d"]],
    ["a.csproj", ['<Project Sdk="x">', "  <!-- c -->", "</Project>"]],
    ["lib.rs", ["fn main() {", '  println!("hi");', "}"]],
    ["a.css", [".a {", "  color: #fff;", "}"]],
    ["a.scss", ["$a: 1px;", ".b { .c { margin: $a; } }"]],
    ["README.md", ["# Title", "", "Some *text* and `code`."]],
    ["a.sh", ["#!/bin/sh", 'echo "$HOME"']],
    ["a.ps1", ["$a = Get-Item .", "Write-Host $a"]],
    ["a.py", ["def f(x):", '    """doc', '    """', "    return x"]],
    ["a.go", ["package main", "func main() {}"]],
    ["A.java", ["class A {", "  int b = 1;", "}"]],
    ["a.kt", ["fun main() {", '  val a = "b"', "}"]],
    ["a.sql", ["SELECT a", "FROM b WHERE c = 'd';"]],
    ["a.toml", ["[a]", 'b = "c"']],
    ["Dockerfile", ["FROM node:20", "RUN echo hi"]],
  ])("keeps every line's text intact for %s", (path, texts) => {
    const lines: DiffLine[] = texts.map((text, i) => ({
      kind: i % 3 === 1 ? "del" : i % 3 === 2 ? "add" : "ctx",
      text,
      line: i + 1,
    }));
    const tokens = highlightLines(lines, path);
    expect(tokens).not.toBeNull();
    expect(tokens!.map((line) => line.map((t) => t.text).join(""))).toEqual(texts);
    expect(tokens!.flat().some((t) => t.className !== null)).toBe(true);
  });

  it("returns null for unknown file types", () => {
    expect(highlightLines(ctx("hello"), "notes.unknown")).toBeNull();
  });

  it("returns null past the line cap", () => {
    const lines = ctx(...Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, () => "a;"));
    expect(highlightLines(lines, "a.ts")).toBeNull();
  });
});
