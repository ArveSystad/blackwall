import { describe, expect, it } from "vitest";
import { gitRemoteHost, normalizeBaseUrl, urlHost } from "./hosts.js";

describe("gitRemoteHost", () => {
  it.each([
    ["https://github.com/acme/web.git", "github.com"],
    ["https://user@ACME.ghe.com/platform/gateway", "acme.ghe.com"],
    ["https://ghe.local:8443/a/b.git", "ghe.local:8443"],
    ["git@github.com:acme/web.git", "github.com"],
    ["acme.ghe.com:platform/gateway.git", "acme.ghe.com"],
    ["ssh://git@acme.ghe.com:2222/platform/gateway.git", "acme.ghe.com"],
    ["ssh://git@ssh.github.com:443/acme/web.git", "github.com"],
    ["  git@github.com:acme/web.git\n", "github.com"],
  ])("reads the host of %j", (remote, host) => {
    expect(gitRemoteHost(remote)).toBe(host);
  });

  it.each(["/srv/git/web.git", "C:\\code\\web", "C:/code/web", "../web", "", "https://"])(
    "returns undefined for %j",
    (remote) => {
      expect(gitRemoteHost(remote)).toBeUndefined();
    },
  );
});

describe("urlHost", () => {
  it("reads the lower-cased host of a URL", () => {
    expect(urlHost("https://Acme.atlassian.net/browse/BW-1")).toBe("acme.atlassian.net");
    expect(urlHost("not a url")).toBeUndefined();
  });
});

describe("normalizeBaseUrl", () => {
  it("keeps only the origin", () => {
    expect(normalizeBaseUrl("https://ACME.ghe.com/")).toBe("https://acme.ghe.com");
    expect(normalizeBaseUrl("https://acme.atlassian.net/jira/your-work")).toBe(
      "https://acme.atlassian.net",
    );
  });
});
