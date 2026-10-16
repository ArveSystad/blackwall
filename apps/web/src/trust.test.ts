import { LOCKED_TRUST, TRUSTED_LOADS_GLOBAL_CONFIG, type AgentTrust } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  globalConfigNote,
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
