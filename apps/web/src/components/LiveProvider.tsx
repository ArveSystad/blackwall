import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { socketUrl } from "../api";
import { applyServerEvent, createLiveEvents, openLiveSocket, type LiveStatus } from "../live";
import { LiveEventsContext, LiveStatusContext } from "../live-status";

/**
 * Keeps the live event socket open for the app's lifetime and feeds its
 * events into the Query cache, then to `useLiveEvent` listeners. After a
 * reconnect every query is invalidated, since events may have been missed
 * while it was down.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [events] = useState(createLiveEvents);

  useEffect(() => {
    const socket = openLiveSocket({
      url: socketUrl(window.location),
      onEvent: (event) => {
        applyServerEvent(queryClient, event);
        events.emit(event);
      },
      onStatus: setStatus,
      onReconnect: () => void queryClient.invalidateQueries(),
    });
    return () => socket.close();
  }, [queryClient, events]);

  return (
    <LiveStatusContext.Provider value={status}>
      <LiveEventsContext.Provider value={events}>{children}</LiveEventsContext.Provider>
    </LiveStatusContext.Provider>
  );
}
