import { JIRA_EMAIL_META, type Agent } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  addTag,
  agentDraft,
  agentsForRole,
  connectionBaseUrl,
  connectionDraftHost,
  connectionDraftToInput,
  copyName,
  draftToInput,
  emptyConnectionDraft,
  moveItem,
  parseCap,
  parseLines,
  roleIds,
  sameDraft,
  sameRoles,
  withRole,
} from "./settings-forms";

const agent: Agent = {
  id: "a1",
  name: "Security reviewer",
  cli: "copilot",
  model: null,
  prompt: "Look for injection.",
  eligibleStages: ["code-review", "plan-review"],
  permissionOverrides: { allow: ["shell(npm test)"] },
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("agent drafts", () => {
  it("round-trips an agent", () => {
    expect(draftToInput(agentDraft(agent))).toEqual({
      name: "Security reviewer",
      cli: "copilot",
      model: null,
      prompt: "Look for injection.",
      eligibleStages: ["plan-review", "code-review"],
      permissionOverrides: { allow: ["shell(npm test)"] },
    });
  });

  it("trims the name and model and drops blank rule lines", () => {
    const draft = {
      ...agentDraft(),
      name: "  Docs ",
      model: " opus ",
      deny: "\n  Bash(rm:*) \n\n",
    };
    expect(draftToInput(draft)).toMatchObject({
      name: "Docs",
      model: "opus",
      permissionOverrides: { deny: ["Bash(rm:*)"] },
    });
  });

  it("compares drafts by what they would save", () => {
    const draft = agentDraft(agent);
    expect(sameDraft(draft, { ...draft, allow: "shell(npm test)\n" })).toBe(true);
    expect(sameDraft(draft, { ...draft, cli: "claude" })).toBe(false);
  });
});

describe("helpers", () => {
  it("names copies", () => {
    expect(copyName("Planner", ["Planner"])).toBe("Planner (copy)");
    expect(copyName("Planner", ["Planner (copy)", "Planner (copy 2)"])).toBe("Planner (copy 3)");
  });

  it("parses lines", () => {
    expect(parseLines("pnpm test\r\n\n  pnpm lint  ")).toEqual(["pnpm test", "pnpm lint"]);
  });

  it("filters agents by the role's stage", () => {
    const implementer = { ...agent, id: "a2", eligibleStages: ["implement" as const] };
    expect(agentsForRole([agent, implementer], "codeReviewers")).toEqual([agent]);
    expect(agentsForRole([agent, implementer], "implementer")).toEqual([implementer]);
  });
});

describe("role agents", () => {
  it("lists a role's ids", () => {
    expect(roleIds({}, "planner")).toEqual([]);
    expect(roleIds({ planner: "a1" }, "planner")).toEqual(["a1"]);
    expect(roleIds({ codeReviewers: ["a1", "a2"] }, "codeReviewers")).toEqual(["a1", "a2"]);
  });

  it("sets a panel role to the list and a single role to the first id", () => {
    expect(withRole({}, "codeReviewers", ["a1", "a2"])).toEqual({ codeReviewers: ["a1", "a2"] });
    expect(withRole({}, "planner", ["a1", "a2"])).toEqual({ planner: "a1" });
  });

  it("removes a single role without an id and leaves the input alone", () => {
    const roles = { planner: "a1", implementer: "a2" };
    expect(withRole(roles, "planner", [""])).toEqual({ implementer: "a2" });
    expect(withRole(roles, "planner", [])).toEqual({ implementer: "a2" });
    expect(roles).toEqual({ planner: "a1", implementer: "a2" });
  });

  it("compares role agents", () => {
    expect(sameRoles({ planner: "a1" }, { planner: "a1", codeReviewers: [] })).toBe(true);
    expect(sameRoles({ codeReviewers: ["a1", "a2"] }, { codeReviewers: ["a2", "a1"] })).toBe(false);
    expect(sameRoles({ planner: "a1" }, {})).toBe(false);
  });
});

describe("caps", () => {
  it("accepts whole numbers from 1 to 20", () => {
    expect(parseCap("1")).toBe(1);
    expect(parseCap("20")).toBe(20);
    for (const text of ["0", "21", "2.5", "", "  "]) expect(parseCap(text)).toBeNull();
  });
});

describe("tags", () => {
  it("normalises and appends a tag", () => {
    expect(addTag(["ux"], " Flaky Tests ")).toEqual({ ok: true, tags: ["ux", "flaky-tests"] });
  });

  it("rejects duplicates and bad names", () => {
    expect(addTag(["ux"], "UX")).toEqual({ ok: false, error: "ux is already listed" });
    expect(addTag([], "c++").ok).toBe(false);
    expect(addTag([], "   ").ok).toBe(false);
  });

  it("moves items within bounds", () => {
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 2, -2)).toEqual(["c", "a", "b"]);
  });
});

describe("connection drafts", () => {
  const hostError = "Enter a host such as github.com or a URL such as https://jbf.ghe.com";

  it("normalises a host or URL to its origin", () => {
    expect(connectionBaseUrl("github.com")).toBe("https://github.com");
    expect(connectionBaseUrl(" https://jbf.ghe.com/foo/ ")).toBe("https://jbf.ghe.com");
    expect(connectionBaseUrl("http://localhost:8080/x")).toBe("http://localhost:8080");
  });

  it("rejects input that is not an http(s) host", () => {
    for (const host of ["not a host", "http://", "", "ftp://x.com"]) {
      expect(() => connectionBaseUrl(host)).toThrow(hostError);
    }
  });

  it("reads the draft's host without throwing", () => {
    expect(connectionDraftHost("https://jbf.ghe.com/foo/")).toBe("jbf.ghe.com");
    expect(connectionDraftHost("github.com")).toBe("github.com");
    expect(connectionDraftHost("http://localhost:8080/x")).toBe("localhost:8080");
    for (const host of ["", "not a host", "http://"]) {
      expect(connectionDraftHost(host)).toBeNull();
    }
  });

  it("defaults the host for GitHub only", () => {
    expect(emptyConnectionDraft().host).toBe("github.com");
    expect(emptyConnectionDraft("jira").host).toBe("");
  });

  it("names the connection after the host when the name is blank", () => {
    const draft = { ...emptyConnectionDraft(), host: "https://jbf.ghe.com/foo/", name: "  " };
    expect(connectionDraftToInput(draft)).toEqual({
      name: "jbf.ghe.com",
      kind: "github",
      baseUrl: "https://jbf.ghe.com",
      authMeta: {},
    });
    expect(connectionDraftToInput({ ...draft, name: " Work GHE " }).name).toBe("Work GHE");
  });

  it("puts the Jira email in authMeta", () => {
    const draft = {
      ...emptyConnectionDraft("jira"),
      host: "acme.atlassian.net",
      email: " me@acme.test ",
    };
    expect(connectionDraftToInput(draft).authMeta).toEqual({ [JIRA_EMAIL_META]: "me@acme.test" });
  });

  it("includes the token only when it is set", () => {
    expect(connectionDraftToInput({ ...emptyConnectionDraft(), token: "   " })).not.toHaveProperty(
      "token",
    );
    expect(connectionDraftToInput({ ...emptyConnectionDraft(), token: " t " }).token).toBe("t");
  });

  it("throws the host error for an invalid host", () => {
    expect(() => connectionDraftToInput({ ...emptyConnectionDraft(), host: "not a host" })).toThrow(
      hostError,
    );
  });
});
