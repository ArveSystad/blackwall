import {
  WS_PATH,
  healthResponseSchema,
  parseServerEvent,
  type ClientEvent,
  type HealthResponse,
  type ServerEvent,
} from "@blackwall/shared";

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch("/api/health", signal ? { signal } : {});
  if (!res.ok) throw new Error(`Health check failed (${res.status})`);
  return healthResponseSchema.parse(await res.json());
}

export function socketUrl(location: Pick<Location, "protocol" | "host">): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${WS_PATH}`;
}

export interface Socket {
  send(event: ClientEvent): void;
  close(): void;
}

/** Opens the typed event socket; invalid server messages are dropped. */
export function connectSocket(handlers: {
  onOpen?: () => void;
  onEvent: (event: ServerEvent) => void;
  onClose?: () => void;
}): Socket {
  const ws = new WebSocket(socketUrl(window.location));
  ws.addEventListener("open", () => handlers.onOpen?.());
  ws.addEventListener("close", () => handlers.onClose?.());
  ws.addEventListener("message", (message) => {
    const event = typeof message.data === "string" ? parseServerEvent(message.data) : null;
    if (event) handlers.onEvent(event);
  });
  return {
    send: (event) => ws.send(JSON.stringify(event)),
    close: () => ws.close(),
  };
}
