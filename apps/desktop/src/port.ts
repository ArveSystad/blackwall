import { createServer } from "node:net";

/** Fixed, so the origin (and its localStorage: theme, selected repo) survives restarts. */
export const DESKTOP_PORT = 4712;

/** The desktop server port: `BLACKWALL_DESKTOP_PORT`, default 4712. Throws on an invalid value. */
export function desktopPort(env: Readonly<Record<string, string | undefined>>): number {
  const value = env.BLACKWALL_DESKTOP_PORT;
  if (!value) return DESKTOP_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port from BLACKWALL_DESKTOP_PORT: ${value}`);
  }
  return port;
}

/** Whether `port` on 127.0.0.1 can be listened on right now. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
