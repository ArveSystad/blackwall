import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";

const token = "test-token";
const port = 4711;
const { app } = createApp({ token, getPort: () => port });
const host = `127.0.0.1:${port}`;
const cookie = `${tokenCookieName(port)}=${token}`;

function request(path: string, headers: Record<string, string> = {}) {
  return app.request(`http://${host}${path}`, { headers: { host, ...headers } });
}

describe("app", () => {
  it("serves health with a valid token cookie", async () => {
    const res = await request("/api/health", { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", name: "blackwall" });
  });

  it("accepts localhost as host", async () => {
    const res = await request("/api/health", { cookie, host: `localhost:${port}` });
    expect(res.status).toBe(200);
  });

  it("rejects requests without the token", async () => {
    expect((await request("/api/health")).status).toBe(401);
    expect((await request("/ws")).status).toBe(401);
  });

  it("rejects a wrong token cookie", async () => {
    const res = await request("/api/health", { cookie: `${tokenCookieName(port)}=nope` });
    expect(res.status).toBe(401);
  });

  it.each(["evil.example:4711", "127.0.0.1:9999", "127.0.0.1", ""])(
    "rejects foreign host %j",
    async (badHost) => {
      const res = await request("/api/health", { cookie, host: badHost });
      expect(res.status).toBe(403);
    },
  );

  it("exchanges ?t= for an httpOnly cookie and strips it from the URL", async () => {
    const res = await request(`/some/route?x=1&t=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/some/route?x=1");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(cookie);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  it("rejects a wrong ?t= token", async () => {
    expect((await request("/?t=nope")).status).toBe(401);
  });

  it("redirects the dev session route to the app", async () => {
    const res = await request("/api/session", { cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});
