import type { SearchScope } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useDebounced } from "../hooks";
import { originKey } from "../inbox";
import { cn } from "../lib/utils";
import { reposQuery, searchQuery } from "../query";
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_CHARS,
  flattenResults,
  resultTarget,
  stepSelection,
  type SearchEntry,
} from "../search";
import { closeSearch, useSearchOpen } from "../search-palette";
import { resolveSelectedRepo, setSelectedRepo, useSelectedRepoId } from "../selected-repo";
import { PausedIcon, RepoIcon, SearchIcon } from "./icons";
import { ORIGIN_ICONS } from "./origins";
import { Segmented } from "./Segmented";
import { StatusBadge, pill } from "./StatusBadge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { ErrorText } from "./ui/field";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";

const SCOPES = [
  { value: "all", label: "All repos" },
  { value: "repo", label: "This repo" },
] as const;

const GROUPS = [
  { kind: "task", label: "Tasks" },
  { kind: "backlog", label: "Backlog" },
  { kind: "repo", label: "Repos" },
] as const;

/**
 * The ⌘K / Ctrl+K palette: finds tasks (archived included), waiting and paused backlog items and
 * repos, the selected repo's first. Mounted once at the app root; open state lives in
 * `search-palette.ts`.
 */
export function SearchPalette() {
  const open = useSearchOpen();
  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeSearch()}>
      {/* Mounted only while open, so every opening starts from an empty query. */}
      {open && <PaletteContent />}
    </Dialog>
  );
}

function PaletteContent() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const repos = useQuery(reposQuery);
  const repoId = resolveSelectedRepo(useSelectedRepoId(), repos.data)?.id ?? null;
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const debounced = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const searching = query.trim().length >= SEARCH_MIN_CHARS;
  const search = useQuery(searchQuery(debounced, repoId, repoId ? scope : "all"));

  const entries = useMemo(
    () => (searching ? flattenResults(search.data, repos.data) : []),
    [searching, search.data, repos.data],
  );
  // The selection goes back to the first row whenever the rows change.
  const [selection, setSelection] = useState({ entries, index: 0 });
  const index = entries.length === 0 ? -1 : selection.entries === entries ? selection.index : 0;
  const active = index === -1 ? undefined : entries[index];
  const optionId = (entry: SearchEntry) => `${listId}-${entry.key}`;
  const activeId = active ? optionId(active) : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  function select(next: number) {
    setSelection({ entries, index: next });
  }

  function openEntry(entry: SearchEntry) {
    closeSearch();
    const target = resultTarget(entry);
    if (target.to === "/tasks/$taskId") {
      void navigate({ to: target.to, params: target.params });
      return;
    }
    setSelectedRepo(target.selectRepo);
    void navigate({ to: target.to, params: target.params, search: target.search });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    const delta =
      event.key === "ArrowDown" || (ctrlOnly && event.key.toLowerCase() === "n")
        ? 1
        : event.key === "ArrowUp" || (ctrlOnly && event.key.toLowerCase() === "p")
          ? -1
          : 0;
    if (delta !== 0) {
      event.preventDefault();
      select(stepSelection(index, delta, entries.length));
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (active) openEntry(active);
    }
  }

  return (
    <DialogContent
      className="top-[calc(var(--bw-titlebar-h)_+_12vh)] max-w-[640px] translate-y-0"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        inputRef.current?.focus();
      }}
    >
      <DialogTitle className="sr-only">Search</DialogTitle>
      <DialogDescription className="sr-only">
        Find tasks, backlog items and repos. Arrow keys move, Enter opens.
      </DialogDescription>
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            role="combobox"
            aria-label="Search"
            aria-autocomplete="list"
            aria-expanded={entries.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
            placeholder="Search tasks, backlog and repos"
            className="h-8 pl-8"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <Segmented
          label="Search scope"
          value={repoId ? scope : "all"}
          options={SCOPES}
          onChange={setScope}
          disabled={!repoId}
          className="shrink-0 self-center"
        />
      </div>
      <div className="max-h-[min(60vh,480px)] overflow-y-auto px-2 py-2">
        <div
          id={listId}
          role="listbox"
          aria-label="Results"
          className={cn("flex flex-col gap-2", entries.length === 0 && "hidden")}
        >
          {GROUPS.map((group) => {
            const rows = entries.filter((e) => e.kind === group.kind);
            if (rows.length === 0) return null;
            const headingId = `${listId}-${group.kind}`;
            return (
              <div key={group.kind} role="group" aria-labelledby={headingId}>
                <div className="flex items-center gap-2 px-1.5 pt-1 pb-1">
                  <span id={headingId} className="label text-muted-foreground">
                    {group.label}
                  </span>
                  <span className="mono text-label text-faint">{rows.length}</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
                {rows.map((entry) => (
                  <div
                    key={entry.key}
                    id={optionId(entry)}
                    role="option"
                    aria-selected={entry === active}
                    // Keeps focus (and the typed query) in the input.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => entry !== active && select(entries.indexOf(entry))}
                    onClick={() => openEntry(entry)}
                    className="flex cursor-pointer flex-col gap-0.5 rounded-lg border border-transparent px-2 py-1.5 aria-selected:border-cyan aria-selected:bg-muted"
                  >
                    <ResultRow entry={entry} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {entries.length === 0 && (
          <PaletteStatus
            query={query.trim()}
            searching={searching}
            loading={search.isFetching || debounced !== query.trim()}
            error={search.isError}
            onRetry={() => void search.refetch()}
          />
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-border bg-card px-4 py-2 text-label text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>↵</Kbd> open
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Esc</Kbd> close
        </span>
      </div>
    </DialogContent>
  );
}

function PaletteStatus({
  query,
  searching,
  loading,
  error,
  onRetry,
}: {
  query: string;
  searching: boolean;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  if (!searching) {
    return (
      <p className="m-0 px-2 py-3 text-meta text-muted-foreground">
        Search tasks, backlog and repos
      </p>
    );
  }
  if (loading) {
    return (
      <p role="status" className="m-0 px-2 py-3 text-meta text-muted-foreground">
        Searching…
      </p>
    );
  }
  if (error) {
    return (
      <div className="flex items-center gap-3 px-2 py-3">
        <ErrorText>Search failed.</ErrorText>
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <p role="status" className="m-0 px-2 py-3 text-meta text-muted-foreground">
      Nothing matches “{query}”
    </p>
  );
}

function ResultRow({ entry }: { entry: SearchEntry }) {
  switch (entry.kind) {
    case "task": {
      const { hit } = entry;
      const Icon = ORIGIN_ICONS[hit.origin.kind];
      return (
        <>
          <div className="flex min-w-0 items-center gap-2.5">
            <Icon className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-body text-foreground-strong">
              {hit.title}
            </span>
            <span className="mono max-w-40 shrink-0 truncate text-label text-faint">
              {originKey(hit)}
            </span>
            <span className="mono max-w-32 shrink-0 truncate text-label text-muted-foreground">
              {hit.repoName}
            </span>
            {hit.archived ? (
              <span className={cn(pill, "bg-muted-foreground/12 text-muted-foreground")}>
                Archived
              </span>
            ) : (
              <StatusBadge status={hit.status} />
            )}
          </div>
          <Snippet text={hit.snippet} />
        </>
      );
    }
    case "backlog": {
      const { hit } = entry;
      const Icon = ORIGIN_ICONS[hit.origin.kind];
      return (
        <>
          <div className="flex min-w-0 items-center gap-2.5">
            <Icon className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-body text-foreground-strong">
              {hit.title}
            </span>
            <span className="mono max-w-32 shrink-0 truncate text-label text-muted-foreground">
              {hit.repoName}
            </span>
            {hit.status === "paused" ? (
              <span className={cn(pill, "gap-1 bg-interrupted/12 text-interrupted")}>
                <PausedIcon size="sm" />
                Paused
              </span>
            ) : (
              <span className="text-label whitespace-nowrap text-muted-foreground">Waiting</span>
            )}
          </div>
          <Snippet text={hit.snippet} />
        </>
      );
    }
    case "repo": {
      const { hit } = entry;
      return (
        <div className="flex min-w-0 items-center gap-2.5">
          <RepoIcon className="text-muted-foreground" />
          <span className="mono shrink-0 text-body text-foreground-strong">{hit.name}</span>
          <span className="mono min-w-0 flex-1 truncate text-label text-faint" title={hit.path}>
            {hit.path}
          </span>
        </div>
      );
    }
  }
}

/** The excerpt around a match outside the title, as plain text. */
function Snippet({ text }: { text: string | null }) {
  if (!text) return null;
  return <p className="m-0 truncate pl-6 text-meta text-faint">{text}</p>;
}
