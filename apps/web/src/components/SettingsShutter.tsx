import { useBlocker, useRouterState, type ShouldBlockFn } from "@tanstack/react-router";
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isEscapeToLeave } from "../keyboard";
import { prefersReducedMotion } from "../reduced-motion";
import { Settings } from "../settings-chunk";
import {
  SHUTTER_FALLBACK_MS,
  closeShutterPresence,
  initialShutterPresence,
  nextShutterOnPath,
  openShutterPresence,
  settingsSectionOf,
  settleShutterPresence,
  shouldAnimateOpen,
  type ShutterState,
} from "../settings-shutter";
import type { SettingsSection } from "../settings-sections";

/** An in-app open held until the panel covers the page; resolving it lets the URL commit or not. */
interface PendingOpen {
  section: SettingsSection;
  promise: Promise<boolean>;
  resolve: (block: boolean) => void;
}

/**
 * Settings, dropped over the outlet column from under the TopBar like a shutter. The path decides
 * whether it shows: leaving Settings commits at once and the panel slides up over the page already
 * mounted beneath. An in-app open is held by a blocker until the panel has slid down over the
 * current page, so the URL (and the page swap) commits unseen. First load, reduced motion and
 * section switches never slide.
 */
export function SettingsShutter() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [state, setState] = useState<ShutterState>(() => ({
    presence: initialShutterPresence(pathname),
    section: settingsSectionOf(pathname) ?? "connections",
  }));
  const [seenPath, setSeenPath] = useState(pathname);

  if (pathname !== seenPath) {
    setSeenPath(pathname);
    const next = nextShutterOnPath(state, pathname, prefersReducedMotion());
    if (next !== state) setState(next);
  }

  // The blocker runs outside render, so it reads the latest state and the held open from refs.
  const latest = useRef(state);
  const pending = useRef<PendingOpen | null>(null);
  useLayoutEffect(() => {
    latest.current = state;
  });

  const update = useCallback((next: ShutterState) => {
    latest.current = next;
    setState(next);
  }, []);

  /** Lets the held navigation through (`false`) or drops it (`true`). */
  const release = useCallback((block: boolean) => {
    const held = pending.current;
    pending.current = null;
    held?.resolve(block);
  }, []);

  /** Drops the held open and slides the panel back up; the URL stays on the page. */
  const cancelOpen = useCallback(() => {
    release(true);
    const current = latest.current;
    update({
      ...current,
      presence: closeShutterPresence(current.presence, prefersReducedMotion()),
    });
  }, [release, update]);

  const shouldBlockFn = useCallback<ShouldBlockFn>(
    async ({ current, next }) => {
      const held = pending.current;
      if (held) {
        // A repeat of the held open (or its redirect) waits on the same hold.
        if (settingsSectionOf(next.pathname) === held.section) return held.promise;
        cancelOpen();
      }
      if (!shouldAnimateOpen(current.pathname, next.pathname) || prefersReducedMotion()) {
        return false;
      }
      const section = settingsSectionOf(next.pathname) ?? "connections";
      try {
        await Settings.preload?.();
      } catch {
        // The route's loader reports the failure; the navigation goes through unanimated.
        return false;
      }
      const presence = openShutterPresence(latest.current.presence, false);
      update({ presence, section });
      if (presence === "open") return false;
      let resolve!: (block: boolean) => void;
      const promise = new Promise<boolean>((r) => (resolve = r));
      release(true);
      pending.current = { section, promise, resolve };
      return promise;
    },
    [cancelOpen, release, update],
  );

  useBlocker({ shouldBlockFn, enableBeforeUnload: false, withResolver: false });

  const { presence, section } = state;

  // Covered: the held open commits now.
  useEffect(() => {
    if (presence === "open") release(false);
  }, [presence, release]);

  // Unmounting never leaves a navigation hanging.
  useEffect(() => () => release(true), [release]);

  // Esc while sliding down: the URL is still the old page, whose own Esc must not fire, so this
  // listens in the capture phase and claims the key.
  useEffect(() => {
    if (presence !== "opening") return;
    function onKeyDown(event: KeyboardEvent) {
      if (!pending.current || !isEscapeToLeave(event) || document.querySelector("[role=dialog]")) {
        return;
      }
      event.preventDefault();
      cancelOpen();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [presence, cancelOpen]);

  const settle = useCallback(() => {
    const current = latest.current;
    const settled = settleShutterPresence(current.presence);
    if (settled !== current.presence) update({ ...current, presence: settled });
  }, [update]);

  // `transitionend` may never come (background tab, old engine), so a timeout settles the slide too.
  useEffect(() => {
    if (presence !== "opening" && presence !== "closing") return;
    const timer = window.setTimeout(settle, SHUTTER_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [presence, settle]);

  if (presence === "closed") return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-clip">
      <div
        className="bw-shutter pointer-events-auto relative h-full min-w-0 bg-background"
        data-shutter={presence}
        inert={presence !== "open"}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === "transform") settle();
        }}
      >
        <Suspense fallback={null}>
          <Settings section={section} escapeEnabled={presence === "open"} />
        </Suspense>
      </div>
    </div>
  );
}
