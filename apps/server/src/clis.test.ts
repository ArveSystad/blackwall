import type { CliStatus } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";

const launchToken = "test-token";
const port = 4711;
const host = `127.0.0.1:${port}`;
const cookie = `${tokenCookieName(port)}=${launchToken}`;

const detected: CliStatus[] = [
  { cli: "claude", installed: true, version: "2.1.294", error: null },
  { cli: "copilot", installed: false, version: null, error: "copilot not found on PATH" },
];

describe("CLI routes", () => {
  it("returns the detected CLIs", async () => {
    const { app } = createApp({
      token: launchToken,
      getPort: () => port,
      clis: () => Promise.resolve(detected),
    });
    const res = await app.request(`http://${host}/api/clis`, { headers: { host, cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(detected);
  });
});
