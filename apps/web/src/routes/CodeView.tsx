import type { RepoFile, RepoTree } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { paneHeader, paneTitle } from "../components/classes";
import { CommitDialog } from "../components/CommitDialog";
import { DiffView } from "../components/DiffView";
import { EmptyState } from "../components/EmptyState";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CodeIcon,
  FileIcon,
  FolderIcon,
} from "../components/icons";
import { Segmented } from "../components/Segmented";
import { DiffStat } from "../components/task/DiffPanel";
import { Button } from "../components/ui/button";
import {
  buildFileTree,
  changeLetter,
  fileLines,
  filterChanged,
  type FileTreeNode,
} from "../code-view";
import { cn } from "../lib/utils";
import { repoCodeFileQuery, repoCodeTreeQuery, reposQuery } from "../query";
import { highlightLines } from "../syntax";

type Filter = "all" | "changed";

/**
 * The selected repo's working copy: a file tree on the left, the picked file
 * on the right with its uncommitted changes inline. Read-only apart from the
 * Commit button. Polls, so edits made elsewhere show up on their own.
 */
export function CodeView({ repoId, file }: { repoId: string; file: string | undefined }) {
  const navigate = useNavigate();
  const repos = useQuery(reposQuery);
  const repo = repos.data?.find((r) => r.id === repoId);
  const tree = useQuery(repoCodeTreeQuery(repoId));
  const [filter, setFilter] = useState<Filter>("all");
  const [committing, setCommitting] = useState(false);

  const changed = tree.data?.files.filter((f) => f.change !== null).length ?? 0;

  const select = (path: string) =>
    void navigate({
      to: "/repos/$repoId/code",
      params: { repoId },
      search: { file: path },
      replace: true,
    });

  if (repos.data && !repo) {
    return (
      <EmptyState key="not-found" title="Repo not found">
        It may have been removed in Settings.
      </EmptyState>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* `pr-14` keeps the last control clear of the window's close button. */}
      <div className={cn(paneHeader, "flex-wrap gap-y-1.5 pr-14")}>
        <CodeIcon className="text-muted-foreground" />
        <h1 className={paneTitle}>Code</h1>
        <span className="mono min-w-0 truncate text-meta text-muted-foreground" title={repo?.name}>
          {repo?.name ?? ""}
        </span>
        {tree.data && (
          <>
            <span className="mono text-meta text-muted-foreground">{tree.data.branch}</span>
            <span className="mono text-label text-faint">{changed} changed</span>
          </>
        )}
        <span className="flex-1" />
        <Segmented
          label="Files"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All files" },
            { value: "changed", label: "Changed" },
          ]}
        />
        <Button
          size="sm"
          className="shrink-0"
          disabled={!tree.data || !repo || changed === 0}
          title={changed === 0 ? "Nothing to commit: the working copy is clean" : undefined}
          onClick={() => setCommitting(true)}
        >
          Commit
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[300px] shrink-0 flex-col border-r border-border">
          {tree.isPending ? (
            <EmptyState key="loading" role="status" title="Reading the file tree…" />
          ) : tree.isError ? (
            <EmptyState
              key="error"
              role="alert"
              title="Could not read the file tree"
              onRetry={() => void tree.refetch()}
            >
              {tree.error.message}
            </EmptyState>
          ) : (
            <FileTree data={tree.data} filter={filter} selected={file} onSelect={select} />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {file ? (
            <FilePane key={file} repoId={repoId} path={file} />
          ) : (
            <EmptyState title="Nothing on screen">Pick a file to read it.</EmptyState>
          )}
        </div>
      </div>

      {committing && repo && tree.data && (
        <CommitDialog
          repo={repo}
          tree={tree.data}
          onClose={() => setCommitting(false)}
          onCommitted={() => setCommitting(false)}
        />
      )}
    </div>
  );
}

/** A visible tree row: the node and how deep it sits. */
interface Row {
  node: FileTreeNode;
  depth: number;
  parent: string | null;
}

function visibleRows(
  nodes: readonly FileTreeNode[],
  isOpen: (path: string) => boolean,
  depth = 0,
  parent: string | null = null,
): Row[] {
  return nodes.flatMap((node) => [
    { node, depth, parent },
    ...(node.kind === "folder" && isOpen(node.path)
      ? visibleRows(node.children, isOpen, depth + 1, node.path)
      : []),
  ]);
}

/** The folders holding `path`, outermost first. */
function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * The repo's files as a `role="tree"`: folders start collapsed (open while
 * filtered to changed files). Arrow keys move, open and close; Enter picks.
 */
function FileTree({
  data,
  filter,
  selected,
  onSelect,
}: {
  data: RepoTree;
  filter: Filter;
  selected: string | undefined;
  onSelect: (path: string) => void;
}) {
  const nodes = useMemo(() => {
    const all = buildFileTree(data.files);
    return filter === "changed" ? filterChanged(all) : all;
  }, [data.files, filter]);
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(selected ? ancestorsOf(selected) : []),
  );
  const isOpen = (path: string) => filter === "changed" || open.has(path);
  const rows = visibleRows(nodes, isOpen);
  const [focused, setFocused] = useState<string | undefined>(selected);
  const refs = useRef(new Map<string, HTMLElement>());
  const focusIndex = Math.max(
    0,
    rows.findIndex((row) => row.node.path === focused),
  );

  const toggle = (path: string, next: boolean) =>
    setOpen((current) => {
      const copy = new Set(current);
      if (next) copy.add(path);
      else copy.delete(path);
      return copy;
    });

  const moveTo = (path: string | undefined) => {
    if (path === undefined) return;
    setFocused(path);
    refs.current.get(path)?.focus();
  };

  const activate = (node: FileTreeNode) => {
    if (node.kind === "folder") toggle(node.path, !isOpen(node.path));
    else onSelect(node.path);
  };

  function onKeyDown(event: KeyboardEvent, index: number) {
    const row = rows[index]!;
    const { node } = row;
    switch (event.key) {
      case "ArrowDown":
        moveTo(rows[index + 1]?.node.path);
        break;
      case "ArrowUp":
        moveTo(rows[index - 1]?.node.path);
        break;
      case "Home":
        moveTo(rows[0]?.node.path);
        break;
      case "End":
        moveTo(rows.at(-1)?.node.path);
        break;
      case "ArrowRight":
        if (node.kind !== "folder") return;
        if (!isOpen(node.path)) toggle(node.path, true);
        else moveTo(node.children[0]?.path);
        break;
      case "ArrowLeft":
        if (node.kind === "folder" && isOpen(node.path) && filter === "all") {
          toggle(node.path, false);
        } else moveTo(row.parent ?? undefined);
        break;
      case "Enter":
      case " ":
        activate(node);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  if (rows.length === 0) {
    return (
      <EmptyState title={filter === "changed" ? "No changes" : "No files"}>
        {filter === "changed" ? "The working copy matches HEAD." : "The repo has no files yet."}
      </EmptyState>
    );
  }

  return (
    <ul
      role="tree"
      aria-label="Files"
      className="m-0 flex min-h-0 flex-1 list-none flex-col overflow-auto p-1.5"
    >
      {rows.map((row, index) => {
        const { node } = row;
        const folder = node.kind === "folder";
        const expanded = folder && isOpen(node.path);
        const active = node.path === selected;
        const letter = folder ? "" : changeLetter(node.change);
        return (
          <li
            key={node.path}
            ref={(element) => {
              if (element) refs.current.set(node.path, element);
              else refs.current.delete(node.path);
            }}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={folder ? expanded : undefined}
            aria-selected={folder ? undefined : active}
            tabIndex={index === focusIndex ? 0 : -1}
            title={node.path}
            onClick={() => {
              setFocused(node.path);
              activate(node);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "bw-chamfer flex h-7 cursor-pointer items-center gap-1.5 pr-2 text-[12.5px] [--bw-chamfer-line:transparent] hover:bg-card focus-visible:outline-none focus-visible:[--bw-chamfer-line:var(--border-strong)]",
              active && "bg-muted [--bw-chamfer-line:var(--border-strong)] hover:bg-muted",
              !folder && node.change !== null && "text-foreground-strong",
            )}
            style={{ paddingLeft: 6 + row.depth * 14 }}
          >
            {folder ? (
              expanded ? (
                <ChevronDownIcon size="sm" className="text-faint" />
              ) : (
                <ChevronRightIcon size="sm" className="text-faint" />
              )
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            {folder ? (
              <FolderIcon size="sm" className="text-muted-foreground" />
            ) : (
              <FileIcon size="sm" className="text-faint" />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                node.kind === "file" && node.change === "deleted" && "line-through",
              )}
            >
              {node.name}
            </span>
            {folder
              ? node.changed > 0 && (
                  <span
                    className="mono text-label text-faint"
                    aria-label={`${node.changed} changed`}
                  >
                    {node.changed}
                  </span>
                )
              : letter && (
                  <span
                    className={cn("mono w-3 text-center text-label", changeTone(node.change))}
                    aria-label={node.change ?? undefined}
                  >
                    {letter}
                  </span>
                )}
          </li>
        );
      })}
    </ul>
  );
}

function changeTone(change: RepoFile["change"]): string {
  if (change === "deleted") return "text-diff-del-fg";
  if (change === "added" || change === "untracked") return "text-diff-add-fg";
  return "text-needs";
}

/** The picked file: its path, change and stats, then its lines with changes inline. */
function FilePane({ repoId, path }: { repoId: string; path: string }) {
  const file = useQuery(repoCodeFileQuery(repoId, path));
  const lines = useMemo(() => (file.data ? fileLines(file.data) : []), [file.data]);
  const tokens = useMemo(() => highlightLines(lines, path), [lines, path]);
  const stat = useMemo(
    () => ({
      additions: lines.filter((line) => line.kind === "add").length,
      deletions: lines.filter((line) => line.kind === "del").length,
    }),
    [lines],
  );

  return (
    <>
      <div className="flex min-h-10 items-center gap-2.5 border-b border-border px-5 py-2">
        <span className="mono min-w-0 truncate text-[12.5px] text-foreground-strong" title={path}>
          {path}
        </span>
        {file.data?.change && (
          <span className={cn("mono text-label", changeTone(file.data.change))}>
            {changeLetter(file.data.change)}
          </span>
        )}
        {file.data?.change && <DiffStat {...stat} />}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
        {file.isPending ? (
          <EmptyState key="loading" role="status" title="Reading the file…" />
        ) : file.isError ? (
          <EmptyState
            key="error"
            role="alert"
            title="Could not read the file"
            onRetry={() => void file.refetch()}
          >
            {file.error.message}
          </EmptyState>
        ) : file.data.kind === "binary" ? (
          <EmptyState title="Binary file">Not shown.</EmptyState>
        ) : file.data.kind === "too-large" ? (
          <EmptyState title="Larger than 1 MB">Not shown.</EmptyState>
        ) : file.data.kind === "symlink" ? (
          <EmptyState title="Symlink">Not followed.</EmptyState>
        ) : lines.length === 0 ? (
          <EmptyState title="Empty file" />
        ) : (
          <DiffView lines={lines} tokens={tokens ?? undefined} className="text-[12.5px]" />
        )}
      </div>
    </>
  );
}
