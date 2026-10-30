import { describe, expect, it } from "vitest";
import {
  claudeSubagents,
  copilotSubagentFile,
  opencodeSubagent,
  SUBAGENT_NAME,
} from "./subagents.js";

describe("Claude Code worker", () => {
  it("gives read-only workers read tools and no edit tools", () => {
    const worker = JSON.parse(claudeSubagents("read-only"))[SUBAGENT_NAME];
    expect(worker.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(worker.tools).not.toContain("Edit");
    expect(worker.tools).not.toContain("Write");
    expect(worker.tools).not.toContain("Agent");
    expect(worker.model).toBe("haiku");
    expect(worker.prompt).toContain("You are read-only");
    expect(worker.prompt).not.toContain("Do not commit, push");
  });

  it("gives implementing workers edit tools and the delivery rules", () => {
    const worker = JSON.parse(claudeSubagents("implement"))[SUBAGENT_NAME];
    expect(worker.tools).toEqual(expect.arrayContaining(["Edit", "Write", "Bash"]));
    expect(worker.tools).not.toContain("Agent");
    expect(worker.prompt).toContain("Do not commit, push");
    expect(worker.prompt).not.toContain("You are read-only");
  });
});

describe("Copilot CLI worker", () => {
  const toolsLine = (file: string) => file.split("\n").find((line) => line.startsWith("tools: "));

  it("gives read-only workers read, search and shell tools but not edit", () => {
    const file = copilotSubagentFile("read-only");
    expect(file).toContain(`name: ${SUBAGENT_NAME}`);
    expect(toolsLine(file)).toBe('tools: ["read","search","shell"]');
    expect(toolsLine(file)).not.toContain('"edit"');
    expect(file).toContain("You are read-only");
    expect(file).not.toContain("Do not commit, push");
  });

  it("gives implementing workers edit and the delivery rules", () => {
    const file = copilotSubagentFile("implement");
    expect(toolsLine(file)).toContain('"edit"');
    expect(file).toContain("Do not commit, push");
    expect(file).not.toContain("You are read-only");
  });
});

describe("OpenCode worker", () => {
  const readOnlyPermission = { "*": "deny", edit: "deny" } as const;

  it("defines a read-only worker that cannot start sub-agents", () => {
    const worker = opencodeSubagent("read-only", { ...readOnlyPermission });
    expect(worker).toMatchObject({ mode: "subagent" });
    expect(worker.description).toContain("read-only helper");
    expect(worker.permission).toMatchObject({ "*": "deny", edit: "deny", task: "deny" });
    expect(worker.prompt).toContain("You are read-only");
    expect(worker).not.toHaveProperty("model");
  });

  it("runs on the given model when one is set", () => {
    const worker = opencodeSubagent("read-only", { ...readOnlyPermission }, "anthropic/x");
    expect(worker.model).toBe("anthropic/x");
  });
});
