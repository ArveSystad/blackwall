import { APP_NAME } from "@blackwall/shared";
import { useEffect, useState } from "react";
import { connectSocket, fetchHealth } from "./api";

type Status =
  { state: "pending" } | { state: "ok"; detail: string } | { state: "error"; detail: string };

function useHealth(): Status {
  const [status, setStatus] = useState<Status>({ state: "pending" });
  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((health) => setStatus({ state: "ok", detail: health.status }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setStatus({ state: "error", detail: String(error) });
      });
    return () => controller.abort();
  }, []);
  return status;
}

function useSocketPing(): Status {
  const [status, setStatus] = useState<Status>({ state: "pending" });
  useEffect(() => {
    const sentAt = new Map<string, number>();
    const socket = connectSocket({
      onOpen: () => {
        const id = crypto.randomUUID();
        sentAt.set(id, performance.now());
        socket.send({ type: "ping", payload: { id } });
      },
      onEvent: (event) => {
        if (event.type === "pong") {
          const started = sentAt.get(event.payload.id);
          if (started === undefined) return;
          setStatus({
            state: "ok",
            detail: `pong in ${Math.round(performance.now() - started)} ms`,
          });
        } else {
          setStatus({ state: "error", detail: event.payload.message });
        }
      },
      onClose: () =>
        setStatus((current) =>
          current.state === "ok" ? current : { state: "error", detail: "connection closed" },
        ),
    });
    return () => socket.close();
  }, []);
  return status;
}

function describe(status: Status): string {
  return status.state === "pending" ? "checking…" : `${status.state}: ${status.detail}`;
}

export function App() {
  const health = useHealth();
  const ping = useSocketPing();
  return (
    <main>
      <h1>{APP_NAME}</h1>
      <dl>
        <dt>API</dt>
        <dd data-state={health.state}>{describe(health)}</dd>
        <dt>WebSocket</dt>
        <dd data-state={ping.state}>{describe(ping)}</dd>
      </dl>
    </main>
  );
}
