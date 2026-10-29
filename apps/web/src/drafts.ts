import { useEffect, useRef, useState } from "react";

/**
 * Unsent input — chat messages, grill answers, the plan approval comment, hunk comments — kept
 * per browser so it survives switching tasks or views and reloading. Each draft sits under
 * `blackwall.drafts.<key>` as `{ value, at }`; sending or clearing the input removes it, deleting
 * a task removes that task's drafts, and drafts untouched for 14 days are dropped on load.
 * An in-memory copy is the source of truth for the page; storage is written shortly behind it.
 */
export const DRAFT_STORAGE_PREFIX = "blackwall.drafts.";

/** Drafts not touched for this long are dropped when the app loads. */
export const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** How long typing settles before a draft is written to storage. */
const WRITE_DELAY_MS = 300;

interface Entry {
  value: unknown;
  at: number;
}

const drafts = new Map<string, Entry>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
let initialized = false;

function storage(): Storage | undefined {
  return globalThis.localStorage;
}

/** Every storage key under the drafts prefix. Unreadable storage means none. */
function storedKeys(): string[] {
  const keys: string[] = [];
  try {
    const store = storage();
    if (!store) return keys;
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(DRAFT_STORAGE_PREFIX)) keys.push(key);
    }
  } catch {
    // Storage is a convenience; drafts still last for this page.
  }
  return keys;
}

function parseEntry(raw: string | null): Entry | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("value" in parsed)) return undefined;
    const at = (parsed as { at?: unknown }).at;
    if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
    return { value: (parsed as { value: unknown }).value, at };
  } catch {
    return undefined;
  }
}

function removeStored(storageKey: string): void {
  try {
    storage()?.removeItem(storageKey);
  } catch {
    // Storage is a convenience; the draft is gone for this page.
  }
}

/** Loads stored drafts once per page, dropping unreadable and stale ones. */
function init(): void {
  if (initialized) return;
  initialized = true;
  const now = Date.now();
  for (const storageKey of storedKeys()) {
    let raw: string | null;
    try {
      raw = storage()?.getItem(storageKey) ?? null;
    } catch {
      continue;
    }
    const entry = parseEntry(raw);
    if (!entry || now - entry.at > DRAFT_MAX_AGE_MS) removeStored(storageKey);
    else drafts.set(storageKey.slice(DRAFT_STORAGE_PREFIX.length), entry);
  }
  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("pagehide", flushDrafts);
  }
}

function persist(key: string): void {
  const entry = drafts.get(key);
  if (!entry) return;
  try {
    storage()?.setItem(DRAFT_STORAGE_PREFIX + key, JSON.stringify(entry));
  } catch {
    // Storage is a convenience; the draft still lasts for this page.
  }
}

function cancelPending(key: string): void {
  const timer = pending.get(key);
  if (timer === undefined) return;
  clearTimeout(timer);
  pending.delete(key);
}

/** The draft under `key`, if one is kept and `parse` accepts it. */
export function readDraft<T>(key: string, parse: (raw: unknown) => T | undefined): T | undefined {
  init();
  const entry = drafts.get(key);
  if (!entry) return undefined;
  try {
    return parse(entry.value);
  } catch {
    return undefined;
  }
}

/** Keeps `value` as the draft under `key`: at once for this page, in storage shortly after. */
export function writeDraft<T>(key: string, value: T): void {
  init();
  drafts.set(key, { value, at: Date.now() });
  cancelPending(key);
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      persist(key);
    }, WRITE_DELAY_MS),
  );
}

/** Drops the draft under `key`, from this page and storage, e.g. once it is sent. */
export function removeDraft(key: string): void {
  init();
  cancelPending(key);
  drafts.delete(key);
  removeStored(DRAFT_STORAGE_PREFIX + key);
}

/** Writes every draft still waiting on its delay to storage now. */
export function flushDrafts(): void {
  for (const key of [...pending.keys()]) {
    cancelPending(key);
    persist(key);
  }
}

/** Drops every draft of a task, e.g. once it is deleted. */
export function clearTaskDrafts(taskId: string): void {
  init();
  const prefix = `task:${taskId}:`;
  for (const key of [...drafts.keys()]) {
    if (key.startsWith(prefix)) removeDraft(key);
  }
  for (const storageKey of storedKeys()) {
    if (storageKey.startsWith(DRAFT_STORAGE_PREFIX + prefix)) removeStored(storageKey);
  }
}

/** A short stamp of `text` (djb2, base36), to tell whether a draft was written against it. */
export function draftStamp(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/** How a draft's value is stored: what counts as nothing typed, and what a stored value is. */
export interface DraftCodec<T> {
  empty: T;
  isEmpty(value: T): boolean;
  parse(raw: unknown): T | undefined;
}

const textCodec: DraftCodec<string> = {
  empty: "",
  isEmpty: (value) => value.trim() === "",
  parse: (raw) => (typeof raw === "string" ? raw : undefined),
};

/**
 * Input state kept as a draft under `key`: `[value, set, clear]`. Setting an empty value drops
 * the draft; `clear` resets the input and drops it, and still drops it after unmount.
 */
export function useDraft(key: string): [string, (value: string) => void, () => void];
export function useDraft<T>(key: string, codec: DraftCodec<T>): [T, (value: T) => void, () => void];
export function useDraft<T>(
  key: string,
  codec: DraftCodec<T> = textCodec as unknown as DraftCodec<T>,
): [T, (value: T) => void, () => void] {
  const [value, setValue] = useState<T>(() => readDraft(key, codec.parse) ?? codec.empty);
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    setSeenKey(key);
    setValue(readDraft(key, codec.parse) ?? codec.empty);
  }
  const empty = useRef(codec.empty);
  useEffect(() => {
    empty.current = codec.empty;
  });
  useEffect(() => () => flushDrafts(), []);

  function set(next: T) {
    setValue(next);
    if (codec.isEmpty(next)) removeDraft(key);
    else writeDraft(key, next);
  }

  function clear() {
    setValue(empty.current);
    removeDraft(key);
  }

  return [value, set, clear];
}
