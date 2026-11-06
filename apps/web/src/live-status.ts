import { createContext, useContext, useEffect, useRef } from "react";
import { createLiveEvents, type LiveListener, type LiveStatus } from "./live";

export const LiveStatusContext = createContext<LiveStatus>("connecting");

/** State of the live event socket, for the connection indicator. */
export function useLiveStatus(): LiveStatus {
  return useContext(LiveStatusContext);
}

/** The live event bus `LiveProvider` feeds; outside it, a bus nothing emits on. */
export const LiveEventsContext = createContext(createLiveEvents());

/**
 * Calls `listener` with each live server event, after the Query cache has it,
 * while `enabled`. The latest listener is used, so a new identity never
 * resubscribes.
 */
export function useLiveEvent(listener: LiveListener, enabled = true): void {
  const events = useContext(LiveEventsContext);
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  useEffect(() => {
    if (!enabled) return;
    return events.subscribe((event) => latest.current(event));
  }, [events, enabled]);
}
