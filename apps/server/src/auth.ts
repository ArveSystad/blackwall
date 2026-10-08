import { randomBytes, timingSafeEqual } from "node:crypto";
import { TOKEN_QUERY_PARAM } from "@blackwall/shared";
import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";

/** Generates a random per-launch token. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Cookie holding the launch token; scoped by port so parallel instances don't clash. */
export function tokenCookieName(port: number): string {
  return `blackwall_token_${port}`;
}

function tokensMatch(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Rejects requests whose Host header isn't `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding). */
export function hostGuard(getPort: () => number): MiddlewareHandler {
  return async (c, next) => {
    const port = getPort();
    const host = c.req.header("host")?.toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return c.text("Forbidden host", 403);
    }
    await next();
  };
}

/**
 * Exchanges `?t=<token>` for an httpOnly cookie, then redirects to the same URL without the token
 * so it doesn't linger in the address bar or history.
 */
export function tokenExchange(token: string, getPort: () => number): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const supplied = url.searchParams.get(TOKEN_QUERY_PARAM);
    if (supplied === null) return next();
    if (!tokensMatch(token, supplied)) return c.text("Invalid token", 401);

    setCookie(c, tokenCookieName(getPort()), token, {
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
    });
    url.searchParams.delete(TOKEN_QUERY_PARAM);
    return c.redirect(`${url.pathname}${url.search}`, 302);
  };
}

/** Requires the launch-token cookie. */
export function requireToken(token: string, getPort: () => number): MiddlewareHandler {
  return async (c, next) => {
    if (!tokensMatch(token, getCookie(c, tokenCookieName(getPort())))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
