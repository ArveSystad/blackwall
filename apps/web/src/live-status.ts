import { createContext, useContext } from "react";
import type { LiveStatus } from "./live";

export const LiveStatusContext = createContext<LiveStatus>("connecting");

/** State of the live event socket, for the connection indicator. */
export function useLiveStatus(): LiveStatus {
  return useContext(LiveStatusContext);
}
