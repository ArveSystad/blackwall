import { describe, expect, it } from "vitest";
import {
  buildFileTree,
  changeLetter,
  fileLines,
  filterChanged,
  type FileTreeNode,
} from "./code-view";

/** Each node as `name` (files) or `name/ (changed)` with its children, for compact asserts. */
function outline(nodes: readonly FileTreeNode[]): unknown[] {
  return nodes.map((node) =>
    node.kind === "file"
      ? node.name
      : { [`${node.name}/ (${node.changed})`]: outline(node.children) },
  );
}

describe("buildFileTree", () => {
  it("nests paths, lists folders first and sorts case-insensitively", () => {
    const tree = buildFileTree([
      { path: "b.ts", change: null },
      { path: "src/z.ts", change: "modified" },
      { path: "A.md", change: null },
      { path: "src/lib/util.ts", change: "untracked" },
      { path: "src/a.ts", change: null },
      { path: "Docs/x.md", change: null },
    ]);
    expect(outline(tree)).toEqual([
      { "Docs/ (0)": ["x.md"] },
      { "src/ (2)": [{ "lib/ (1)": ["util.ts"] }, "a.ts", "z.ts"] },
      "A.md",
      "b.ts",
    ]);
  });

  it("keeps each file's path and change", () => {
    const [folder] = buildFileTree([{ path: "src/a.ts", change: "deleted" }]);
    expect(folder).toMatchObject({ kind: "folder", path: "src", changed: 1 });
    expect(folder?.kind === "folder" && folder.children[0]).toEqual({
      kind: "file",
      name: "a.ts",
      path: "src/a.ts",
      change: "deleted",
    });
  });
});

describe("filterChanged", () => {
  it("keeps only changed files and the folders holding them", () => {
    const tree = buildFileTree([
      { path: "a.ts", change: null },
      { path: "b.ts", change: "added" },
      { path: "clean/c.ts", change: null },
      { path: "src/d.ts", change: null },
      { path: "src/e.ts", change: "modified" },
    ]);
    expect(outline(filterChanged(tree))).toEqual([{ "src/ (1)": ["e.ts"] }, "b.ts"]);
  });
});

describe("changeLetter", () => {
  it("marks each change with one letter", () => {
    expect(
      (["modified", "added", "deleted", "renamed", "untracked", null] as const).map(changeLetter),
    ).toEqual(["M", "A", "D", "R", "U", ""]);
  });
});

describe("fileLines", () => {
  it("shows a whole-file diff without its hunk header", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "index 1..2 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+deux",
      " three",
    ].join("\n");
    expect(fileLines({ change: "modified", content: "one\ndeux\nthree\n", diff })).toEqual([
      { kind: "ctx", text: "one", line: 1 },
      { kind: "del", text: "two", line: 2 },
      { kind: "add", text: "deux", line: 2 },
      { kind: "ctx", text: "three", line: 3 },
    ]);
  });

  it("numbers an unchanged file's lines as context", () => {
    expect(fileLines({ change: null, content: "a\nb\n", diff: null })).toEqual([
      { kind: "ctx", text: "a", line: 1 },
      { kind: "ctx", text: "b", line: 2 },
    ]);
  });

  it("shows an untracked file as all added", () => {
    expect(fileLines({ change: "untracked", content: "new", diff: null })).toEqual([
      { kind: "add", text: "new", line: 1 },
    ]);
  });

  it("strips CR from CRLF lines, in plain files and diffs", () => {
    expect(fileLines({ change: null, content: "a\r\nb\r\n", diff: null })).toEqual([
      { kind: "ctx", text: "a", line: 1 },
      { kind: "ctx", text: "b", line: 2 },
    ]);
    const diff = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\r\n+b\r";
    expect(fileLines({ change: "modified", content: "b\r\n", diff })).toEqual([
      { kind: "del", text: "a", line: 1 },
      { kind: "add", text: "b", line: 1 },
    ]);
  });

  it("is empty for an empty file", () => {
    expect(fileLines({ change: null, content: "", diff: null })).toEqual([]);
  });
});
