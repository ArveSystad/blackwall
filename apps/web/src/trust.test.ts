import {
  AGENT_CLIS,
  AGENT_TRUST_LEVELS,
  LOCKED_TRUST,
  REMOTE_COMMANDS,
  TRUSTED_LOADS_GLOBAL_CONFIG,
  type AgentTrust,
} from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { CLI_NAMES } from "./settings-forms";
import {
  ALLOW_EVERYTHING_MODES,
  FORCED_LOCKED_HELP,
  PIPELINE_SUBAGENTS,
  READONLY_TRUSTED_SUBAGENTS,
  TRUST_MATRIX,
  alwaysDeniedCommands,
  globalConfigNote,
  perCli,
  trustDetail,
  loadedSkills,
  loadsGlobalConfig,
  otherTrustLevels,
  ranUnrestricted,
  showsTrust,
  trustLabel,
  trustRisk,
} from "./trust";

const trust = (level: AgentTrust["level"], extra: Partial<AgentTrust> = {}): AgentTrust => ({
  ...LOCKED_TRUST,
  level,
  ...extra,
});

describe("trustLabel", () => {
  it("names the level, or why it was forced Locked", () => {
    expect(trustLabel(trust("trusted"))).toBe("Trusted");
    expect(trustLabel(trust("unrestricted"))).toBe("Unrestricted");
    expect(trustLabel({ ...LOCKED_TRUST, forced: true, forcedReason: "review" })).toBe(
      "Locked (Review PR)",
    );
    expect(trustLabel({ ...LOCKED_TRUST, forced: true, forcedReason: "unchecked-branch" })).toBe(
      "Locked until the branch is checked",
    );
    expect(trustLabel({ ...LOCKED_TRUST, forced: true, forcedReason: "foreign-branch" })).toBe(
      "Locked (others' commits on branch)",
    );
  });

  it("shows nothing for a repo that is simply Locked", () => {
    expect(showsTrust(LOCKED_TRUST)).toBe(false);
    expect(showsTrust({ ...LOCKED_TRUST, forced: true, forcedReason: "review" })).toBe(true);
    expect(showsTrust(trust("trusted"))).toBe(true);
  });
});

describe("trustRisk", () => {
  it("has a line per level, with the global-config warning under Trusted", () => {
    expect(trustRisk("locked")).toHaveLength(1);
    expect(trustRisk("unrestricted")[0]).toMatch(/push/);
    const trusted = trustRisk("trusted");
    expect(trusted[0]).toMatch(/skills, sub-agents and instruction files/);
    expect(trusted.some((line) => line.includes("~/.copilot"))).toBe(
      TRUSTED_LOADS_GLOBAL_CONFIG.includes("copilot"),
    );
  });
});

describe("trust help", () => {
  const row = (capability: string) => {
    const found = TRUST_MATRIX.find((r) => r.capability === capability);
    if (!found) throw new Error(`no row ${capability}`);
    return found;
  };

  it("fills every table cell for every level", () => {
    for (const { cells } of TRUST_MATRIX) {
      for (const level of AGENT_TRUST_LEVELS) {
        const cell = cells[level];
        if (typeof cell === "string") {
          expect(cell).not.toBe("");
        } else {
          expect(cell.readOnly).not.toBe("");
          expect(cell.implement).not.toBe("");
        }
      }
    }
  });

  it("denies remote commands except under Unrestricted", () => {
    const { cells } = row("Remote git and gh");
    expect(cells.locked).toBe("denied");
    expect(cells.trusted).toBe("denied");
    expect(cells.unrestricted).toBe("allowed");
    expect(alwaysDeniedCommands()).toEqual(REMOTE_COMMANDS);
    expect(alwaysDeniedCommands()).toContain("git push");
    expect(alwaysDeniedCommands()).toContain("gh");
  });

  it("explains each level, with the global-config note and the allow-everything modes", () => {
    for (const level of AGENT_TRUST_LEVELS) expect(trustDetail(level).length).toBeGreaterThan(0);
    expect(trustDetail("trusted").some((line) => line.includes("~/.copilot"))).toBe(
      TRUSTED_LOADS_GLOBAL_CONFIG.includes("copilot"),
    );
    const unrestricted = trustDetail("unrestricted").join("\n");
    for (const mode of Object.values(ALLOW_EVERYTHING_MODES)) expect(unrestricted).toContain(mode);
  });

  it("has per-CLI copy for every CLI", () => {
    for (const record of [ALLOW_EVERYTHING_MODES, PIPELINE_SUBAGENTS, READONLY_TRUSTED_SUBAGENTS]) {
      for (const cli of AGENT_CLIS) expect(record[cli]).not.toBe("");
    }
  });

  it("describes which sub-agents each CLI allows", () => {
    // Copilot pipeline agents keep `task`, built-ins included; Claude and OpenCode deny the built-ins.
    expect(PIPELINE_SUBAGENTS.copilot).toMatch(/built-in sub-agents, which follow/);
    expect(PIPELINE_SUBAGENTS.claude).toMatch(/built-in sub-agents are denied/);
    expect(PIPELINE_SUBAGENTS.opencode).toMatch(/built-in sub-agents are denied/);
    // Under Trusted, planners and reviewers get the worker and the repo's sub-agents on every
    // CLI; only Claude's chat reaches the repo's sub-agents.
    for (const cli of AGENT_CLIS) {
      expect(READONLY_TRUSTED_SUBAGENTS[cli]).toMatch(/Blackwall worker.*the repo's sub-agents/);
    }
    expect(READONLY_TRUSTED_SUBAGENTS.claude).not.toMatch(/chat: none/);
    expect(READONLY_TRUSTED_SUBAGENTS.copilot).toMatch(/chat: none/);
    expect(READONLY_TRUSTED_SUBAGENTS.opencode).toMatch(/chat: none/);
  });

  it("groups CLIs with the same text", () => {
    expect(perCli({ claude: "a", copilot: "b", opencode: "b" })).toBe(
      `${CLI_NAMES.claude}: a; ${CLI_NAMES.copilot}, ${CLI_NAMES.opencode}: b`,
    );
    const { cells } = row("Sub-agents");
    expect(cells.locked).toMatchObject({
      readOnly: expect.stringMatching(/^Blackwall worker, read-only/),
    });
    const trusted = cells.trusted;
    if (typeof trusted === "string") throw new Error("expected a split cell");
    expect(trusted.readOnly).toBe(perCli(READONLY_TRUSTED_SUBAGENTS));
    for (const name of Object.values(CLI_NAMES)) expect(trusted.readOnly).toContain(name);
  });

  it("explains every reason trust is forced Locked", () => {
    for (const reason of ["review", "foreign-branch", "unchecked-branch"] as const) {
      expect(FORCED_LOCKED_HELP[reason]).not.toBe("");
    }
  });
});

describe("steps", () => {
  it("tells when any step ran Unrestricted", () => {
    expect(ranUnrestricted([{ trust: "trusted" }, { trust: null }])).toBe(false);
    expect(ranUnrestricted([{ trust: "locked" }, { trust: "unrestricted" }])).toBe(true);
  });

  it("flags Trusted steps of a CLI that loads the user's global config", () => {
    for (const cli of TRUSTED_LOADS_GLOBAL_CONFIG) {
      expect(loadsGlobalConfig({ cli, trust: "trusted" })).toBe(true);
      expect(loadsGlobalConfig({ cli, trust: "locked" })).toBe(false);
      expect(globalConfigNote({ cli, trust: "trusted" })).toMatch(/also loaded your own/);
    }
    expect(loadsGlobalConfig({ cli: "claude", trust: "trusted" })).toBe(false);
    expect(loadsGlobalConfig({ cli: null, trust: null })).toBe(false);
    expect(globalConfigNote({ cli: "claude", trust: "trusted" })).toBeNull();
  });

  it("lists the other levels steps ran under", () => {
    expect(
      otherTrustLevels(
        [{ trust: "trusted" }, { trust: "locked" }, { trust: null }, { trust: "locked" }],
        trust("trusted"),
      ),
    ).toEqual(["locked"]);
  });

  it("reads the last skills-loaded event", () => {
    expect(loadedSkills([{ type: "message", payload: {} }])).toBeNull();
    expect(
      loadedSkills([
        { type: "skills-loaded", payload: { type: "skills-loaded", skills: ["a"] } },
        { type: "skills-loaded", payload: { type: "skills-loaded", skills: ["probe", 3] } },
      ]),
    ).toEqual(["probe"]);
  });
});
