import type { RepoFile, RepoFileChange, RepoTreeFile } from "@blackwall/shared";
import { parseDiff, type DiffLine } from "./task-view";

/** A file or folder in the Code view's tree. */
export type FileTreeNode =
  | { kind: "file"; name: string; path: string; change: RepoFileChange }
  | {
      kind: "folder";
      name: string;
      path: string;
      /** Changed files anywhere below the folder. */
      changed: number;
      children: FileTreeNode[];
    };

type Folder = Extract<FileTreeNode, { kind: "folder" }>;

/**
 * Nests repo-relative paths into folders. Each level lists folders first, then
 * files, each sorted case-insensitively.
 */
export function buildFileTree(files: readonly RepoTreeFile[]): FileTreeNode[] {
  const root: Folder = { kind: "folder", name: "", path: "", changed: 0, children: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let folder = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = folder.children.find(
        (child): child is Folder => child.kind === "folder" && child.path === path,
      );
      if (!next) {
        next = { kind: "folder", name: parts[i]!, path, changed: 0, children: [] };
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push({
      kind: "file",
      name: parts.at(-1)!,
      path: file.path,
      change: file.change,
    });
  }
  countAndSort(root);
  return root.children;
}

function countAndSort(folder: Folder): number {
  let changed = 0;
  for (const child of folder.children) {
    if (child.kind === "folder") changed += countAndSort(child);
    else if (child.change !== null) changed++;
  }
  folder.changed = changed;
  folder.children.sort((a, b) =>
    a.kind !== b.kind
      ? a.kind === "folder"
        ? -1
        : 1
      : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  return changed;
}

/** The tree with only changed files and the folders that hold them. */
export function filterChanged(tree: readonly FileTreeNode[]): FileTreeNode[] {
  return tree.flatMap((node): FileTreeNode[] => {
    if (node.kind === "file") return node.change === null ? [] : [node];
    if (node.changed === 0) return [];
    return [{ ...node, children: filterChanged(node.children) }];
  });
}

/** The mono letter that marks a changed file in the tree. */
export function changeLetter(change: RepoFileChange): string {
  switch (change) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    default:
      return "";
  }
}

/**
 * The lines to show for a file: its whole-file diff without the hunk header
 * when it has one, all added for an untracked file, otherwise numbered context.
 */
export function fileLines(file: Pick<RepoFile, "change" | "content" | "diff">): DiffLine[] {
  if (file.diff !== null) {
    const lines = parseDiff(file.diff)[0]?.lines ?? [];
    return lines
      .filter((line) => line.kind !== "hunk")
      .map((line) => ({ ...line, text: stripCr(line.text) }));
  }
  if (file.content === null || file.content === "") return [];
  const kind = file.change === "untracked" || file.change === "added" ? "add" : "ctx";
  const text = file.content.endsWith("\n") ? file.content.slice(0, -1) : file.content;
  return text.split("\n").map((line, i) => ({ kind, text: stripCr(line), line: i + 1 }));
}

function stripCr(text: string): string {
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}
