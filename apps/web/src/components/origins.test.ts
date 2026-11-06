import { describe, expect, it } from "vitest";
import { ORIGINS, ORIGIN_ICONS, availableOrigins } from "./origins";

describe("origins", () => {
  it("has an icon for every origin", () => {
    for (const { value, icon } of ORIGINS) expect(ORIGIN_ICONS[value]).toBe(icon);
  });
});

describe("availableOrigins", () => {
  const values = (connections: Parameters<typeof availableOrigins>[0]) =>
    availableOrigins(connections).map((o) => o.value);
  const jira = { kind: "jira", hasToken: true } as const;
  const github = { kind: "github", hasToken: true } as const;

  it("keeps only free text without connections", () => {
    expect(values([])).toEqual(["free-text"]);
  });

  it("offers Jira with a Jira connection", () => {
    expect(values([jira])).toEqual(["jira-issue", "free-text"]);
  });

  it("offers both GitHub origins with a GitHub connection", () => {
    expect(values([github])).toEqual(["github-pr", "free-text", "github-issue"]);
  });

  it("offers every origin with both connections", () => {
    expect(values([github, jira])).toEqual(ORIGINS.map((o) => o.value));
  });

  it("ignores connections without a token", () => {
    expect(values([{ ...jira, hasToken: false }])).toEqual(["free-text"]);
    expect(values([{ ...github, hasToken: false }, jira])).toEqual(["jira-issue", "free-text"]);
  });

  it("offers every origin while the connections are unknown", () => {
    expect(values(undefined)).toEqual(ORIGINS.map((o) => o.value));
  });
});
