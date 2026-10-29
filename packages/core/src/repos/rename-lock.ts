import { TaskStateError } from "../pipeline/engine.js";
import { RepoBusyError } from "./service.js";

/** A task or repo action refused while its repo is being renamed. Maps to 409. */
export class RepoRenamingError extends TaskStateError {
  constructor() {
    super("This repo is being renamed; try again when it finishes");
    this.name = "RepoRenamingError";
  }
}

export type RepoRenameLocks = ReturnType<typeof createRepoRenameLocks>;

/**
 * In-memory locks for repo renames. While a repo's lock is held no task in it
 * may start, deliver, re-review or be deleted, and the repo can't be removed.
 * A rename that failed after GitHub was renamed is marked partial until a
 * retry finishes, so the repo record isn't dropped while its folder is moved.
 * Nothing is persisted: a restart frees every lock and forgets partial marks.
 */
export function createRepoRenameLocks() {
  const held = new Set<string>();
  const partial = new Set<string>();
  const listeners = new Set<() => void>();

  function isHeld(repoId: string): boolean {
    return held.has(repoId);
  }

  return {
    /**
     * Takes the repo's lock; throws `RepoBusyError` when it is already taken.
     * The returned release can be called more than once and tells the
     * `onRelease` listeners the first time.
     */
    hold(repoId: string, repoName = "This repo"): () => void {
      if (held.has(repoId)) throw new RepoBusyError(`${repoName} is already being renamed`);
      held.add(repoId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.delete(repoId);
        for (const listener of listeners) listener();
      };
    },

    isHeld,

    /** Throws `RepoRenamingError` while the repo is being renamed. */
    assertFree(repoId: string): void {
      if (held.has(repoId)) throw new RepoRenamingError();
    },

    /** Calls `listener` whenever a lock is released; returns an unsubscribe. */
    onRelease(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Marks a rename that stopped after GitHub was renamed and awaits a retry. */
    markPartial(repoId: string): void {
      partial.add(repoId);
    },

    clearPartial(repoId: string): void {
      partial.delete(repoId);
    },

    /** Whether a rename is running or stopped partway and awaits a retry. */
    isRenaming(repoId: string): boolean {
      return held.has(repoId) || partial.has(repoId);
    },
  };
}
