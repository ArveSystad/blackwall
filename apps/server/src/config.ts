import { parseArgs } from "node:util";
import { resolveDataDir } from "@blackwall/core";

export const DEFAULT_PORT = 4711;
export const DEFAULT_WEB_DEV_PORT = 5173;

export interface ServerConfig {
  /** Port the server listens on (always bound to 127.0.0.1). */
  port: number;
  /** Open the launch URL in the default browser. */
  open: boolean;
  /** Dev mode: the SPA is served by the Vite dev server instead of `apps/web/dist`. */
  dev: boolean;
  /** Origin of the Vite dev server, used for the launch URL in dev mode. */
  webDevOrigin: string;
  /** Data directory holding `blackwall.db` (`BLACKWALL_HOME`, default `~/.blackwall`). */
  dataDir: string;
}

function parsePort(value: string, source: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port from ${source}: ${value}`);
  }
  return port;
}

/** Reads config from CLI args (`--port`, `--no-open`, `--dev`) and env (`BLACKWALL_PORT`, `BLACKWALL_WEB_PORT`, `BLACKWALL_HOME`). */
export function parseConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ServerConfig {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      port: { type: "string" },
      open: { type: "boolean", default: true },
      dev: { type: "boolean", default: false },
    },
    allowNegative: true,
    strict: true,
  });

  const port =
    values.port !== undefined
      ? parsePort(values.port, "--port")
      : env.BLACKWALL_PORT
        ? parsePort(env.BLACKWALL_PORT, "BLACKWALL_PORT")
        : DEFAULT_PORT;
  const webPort = env.BLACKWALL_WEB_PORT
    ? parsePort(env.BLACKWALL_WEB_PORT, "BLACKWALL_WEB_PORT")
    : DEFAULT_WEB_DEV_PORT;

  return {
    port,
    open: values.open,
    dev: values.dev,
    webDevOrigin: `http://127.0.0.1:${webPort}`,
    dataDir: resolveDataDir(env),
  };
}
