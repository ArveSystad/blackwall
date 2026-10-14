import { readFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import type { SystemService } from "@blackwall/core";
import type { CompactResult, SystemInfo } from "@blackwall/shared";
import { Hono } from "hono";

/** blackwall's version from the root `package.json` (relative to `src/` and `dist/`); null on failure. */
export function readVersion(): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export interface SystemRouteOptions {
  system: Pick<SystemService, "snapshot" | "compact">;
  version?: string | null;
}

/** Install facts for Settings → System, and compacting the database. */
export function systemRoutes({ system, version = readVersion() }: SystemRouteOptions): Hono {
  const runtime = (): SystemInfo["runtime"] => ({
    version,
    node: process.version,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    uptimeSeconds: process.uptime(),
  });

  const routes = new Hono();
  routes.get("/", async (c) => {
    const flag = c.req.query("worktreeSizes");
    const snapshot = await system.snapshot({ worktreeSizes: flag === "1" || flag === "true" });
    return c.json<SystemInfo>({ ...snapshot, runtime: runtime() });
  });
  routes.post("/compact", async (c) => {
    const { info, freedBytes } = await system.compact();
    return c.json<CompactResult>({ info: { ...info, runtime: runtime() }, freedBytes });
  });
  return routes;
}
