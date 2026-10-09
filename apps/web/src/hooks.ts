import type { Agent } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { agentsQuery } from "./query";

/** Re-renders every `ms` so relative times and countdowns stay current. */
export function useNow(ms = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** The agent library by id; empty until it loads. */
export function useAgentLibrary(): ReadonlyMap<string, Agent> {
  const agents = useQuery(agentsQuery);
  return useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent])),
    [agents.data],
  );
}
