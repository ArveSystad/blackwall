import { describe, expect, it } from "vitest";
import { routeUrl } from "./external-url.js";

const origin = "http://127.0.0.1:4712";

describe("routeUrl", () => {
  it("keeps same-origin URLs in the app", () => {
    expect(routeUrl(`${origin}/tasks/1`, origin)).toBe("app");
  });

  it("opens web and mail links externally", () => {
    expect(routeUrl("https://github.com/acme/app/pull/1", origin)).toBe("external");
    expect(routeUrl("http://127.0.0.1:5173/", origin)).toBe("external");
    expect(routeUrl("mailto:me@acme.test", origin)).toBe("external");
  });

  it("denies other schemes and garbage", () => {
    expect(routeUrl("file:///etc/passwd", origin)).toBe("deny");
    expect(routeUrl("javascript:alert(1)", origin)).toBe("deny");
    expect(routeUrl("not a url", origin)).toBe("deny");
  });
});
