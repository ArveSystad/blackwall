import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeProjectHooks,
  claudeProjectInstructions,
  frontmatter,
  opencodeProject,
  prepareClaudeProjectPlugin,
  projectMcp,
  stripJsonc,
} from "./project-config.js";

/** Writes `text` to `path`, creating its folders. */
function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Whether a folder link can be made here without special rights (Windows junctions can). */
function canLinkDirs(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "blackwall-link-probe-"));
  try {
    symlinkSync(dir, join(dir, "link"), "junction");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Forward-slash form of a path, for comparing paths across platforms. */
const slashed = (path: string) => path.replace(/\\/g, "/");

describe("stripJsonc", () => {
  it("drops comments and trailing commas, keeping // inside strings", () => {
    const text = `{
  // a line comment
  "url": "https://example.com//docs", /* a block
  comment */
  "list": [1, 2,],
  "quoted": "say \\"hi\\" // not a comment",
}`;
    expect(JSON.parse(stripJsonc(text))).toEqual({
      url: "https://example.com//docs",
      list: [1, 2],
      quoted: 'say "hi" // not a comment',
    });
  });

  it("keeps commas before a bracket inside strings", () => {
    expect(JSON.parse(stripJsonc('{"msg": "see [a, ]", "obj": "{b, }",}'))).toEqual({
      msg: "see [a, ]",
      obj: "{b, }",
    });
  });

  it("leaves plain JSON as it is", () => {
    const text = '{"a":[1,{"b":null}],"c":"d"}';
    expect(stripJsonc(text)).toBe(text);
  });
});

describe("project config files", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "blackwall-project-config-"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  describe("projectMcp", () => {
    it("names the servers of the repo's .mcp.json", async () => {
      write(
        join(repo, ".mcp.json"),
        `{
  // the database
  "mcpServers": { "db": { "command": "node" }, "docs.v2": { "command": "x" } }
}`,
      );
      const mcp = await projectMcp(repo);
      expect(mcp?.servers).toEqual(["db", "docs.v2"]);
      expect(mcp && basename(mcp.path)).toBe(".mcp.json");
    });

    it("skips server names that could not be allowed as tools", async () => {
      write(join(repo, ".mcp.json"), '{"mcpServers":{"ok":{},"bad name":{}}}');
      expect((await projectMcp(repo))?.servers).toEqual(["ok"]);
    });

    it("is undefined without a file, with a malformed one, or without servers", async () => {
      expect(await projectMcp(repo)).toBeUndefined();
      write(join(repo, ".mcp.json"), '{"mcpServers": {');
      expect(await projectMcp(repo)).toBeUndefined();
      write(join(repo, ".mcp.json"), '{"mcpServers": {}}');
      expect(await projectMcp(repo)).toBeUndefined();
    });
  });

  describe("claudeProjectHooks", () => {
    it("returns the hooks of .claude/settings.json and nothing else", async () => {
      write(
        join(repo, ".claude", "settings.json"),
        JSON.stringify({
          permissions: { allow: ["Bash(rm:*)"] },
          hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] },
        }),
      );
      expect(await claudeProjectHooks(repo)).toEqual({
        PreToolUse: [{ matcher: "Bash", hooks: [] }],
      });
    });

    it("is undefined without settings, without hooks, or with malformed settings", async () => {
      expect(await claudeProjectHooks(repo)).toBeUndefined();
      write(join(repo, ".claude", "settings.json"), '{"permissions":{}}');
      expect(await claudeProjectHooks(repo)).toBeUndefined();
      write(join(repo, ".claude", "settings.json"), "{ not json");
      expect(await claudeProjectHooks(repo)).toBeUndefined();
    });
  });

  describe("claudeProjectInstructions", () => {
    it("joins CLAUDE.md and .claude/CLAUDE.md as a system prompt section", async () => {
      write(join(repo, "CLAUDE.md"), "Use pnpm.\n");
      write(join(repo, ".claude", "CLAUDE.md"), "Run the tests first.");
      const text = await claudeProjectInstructions(repo);
      expect(text).toBe(
        "## The repository's own instructions\n\n" +
          "### CLAUDE.md\n\nUse pnpm.\n\n" +
          "### .claude/CLAUDE.md\n\nRun the tests first.",
      );
    });

    it("is undefined without either file", async () => {
      expect(await claudeProjectInstructions(repo)).toBeUndefined();
    });
  });

  describe("prepareClaudeProjectPlugin", () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "blackwall-plugin-root-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("copies the skill tree and the agent files, and writes the plugin manifest", async () => {
      write(join(repo, ".claude", "skills", "probe", "SKILL.md"), "---\nname: probe\n---\n");
      write(join(repo, ".claude", "skills", "probe", "scripts", "run.sh"), "echo hi\n");
      write(join(repo, ".claude", "agents", "review.md"), "---\nname: review\n---\nReview.");
      write(join(repo, ".claude", "agents", "notes.txt"), "not an agent");
      const plugin = await prepareClaudeProjectPlugin(repo, root);
      expect(plugin).toBeDefined();
      const dir = plugin!.dir;
      expect(join(dir, ".."), "plugin dir sits under the root").toBe(root);
      expect(readFileSync(join(dir, "skills", "probe", "SKILL.md"), "utf8")).toContain("probe");
      expect(readFileSync(join(dir, "skills", "probe", "scripts", "run.sh"), "utf8")).toBe(
        "echo hi\n",
      );
      expect(readdirSync(join(dir, "agents"))).toEqual(["review.md"]);
      expect(
        JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")),
      ).toMatchObject({ name: "blackwall-project" });
    });

    it("is undefined, and leaves nothing behind, without skills or agents", async () => {
      write(join(repo, "CLAUDE.md"), "Only instructions.");
      expect(await prepareClaudeProjectPlugin(repo, root)).toBeUndefined();
      expect(readdirSync(root)).toEqual([]);
    });

    it("removes the plugin directory on dispose", async () => {
      write(join(repo, ".claude", "skills", "probe", "SKILL.md"), "x");
      const plugin = await prepareClaudeProjectPlugin(repo, root);
      expect(existsSync(plugin!.dir)).toBe(true);
      await plugin!.dispose();
      expect(readdirSync(root)).toEqual([]);
    });

    const linked = canLinkDirs();
    it.skipIf(!linked)("does not copy a folder link that points outside the repo", async () => {
      const outside = mkdtempSync(join(tmpdir(), "blackwall-outside-"));
      try {
        write(join(outside, "secret.md"), "outside the repo");
        write(join(repo, ".claude", "skills", "own", "SKILL.md"), "mine");
        symlinkSync(outside, join(repo, ".claude", "skills", "leak"), "junction");
        const plugin = await prepareClaudeProjectPlugin(repo, root);
        expect(plugin).toBeDefined();
        const skills = readdirSync(join(plugin!.dir, "skills"));
        expect(skills).toEqual(["own"]);
        expect(existsSync(join(plugin!.dir, "skills", "leak"))).toBe(false);
        await plugin!.dispose();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe("frontmatter", () => {
    it("reads the top-level fields and returns the body", () => {
      const parsed = frontmatter(
        "---\nname: review\ndescription: \"Quoted: value\"\nmodel: 'acme/small'\n---\nBody line\n",
      );
      expect(parsed).toEqual({
        fields: { name: "review", description: "Quoted: value", model: "acme/small" },
        body: "Body line\n",
      });
    });

    it("accepts CRLF line endings", () => {
      expect(frontmatter("---\r\nname: y\r\n---\r\nBody")).toEqual({
        fields: { name: "y" },
        body: "Body",
      });
    });

    it("reads an empty frontmatter block as no fields", () => {
      expect(frontmatter("---\n---\nBody")).toEqual({ fields: {}, body: "Body" });
    });

    it("returns no fields and the whole text without frontmatter", () => {
      expect(frontmatter("Just text")).toEqual({ fields: {}, body: "Just text" });
    });
  });

  describe("opencodeProject", () => {
    it("merges the mcp and plugin entries of both config files, JSON and JSONC", async () => {
      write(
        join(repo, "opencode.json"),
        JSON.stringify({ mcp: { db: { type: "local" } }, plugin: ["p1"] }),
      );
      write(
        join(repo, ".opencode", "opencode.jsonc"),
        `{
  // extra servers
  "mcp": { "docs": { "type": "remote" } },
  "plugin": ["p2", "p1",],
}`,
      );
      const project = await opencodeProject(repo);
      expect(project.mcp).toEqual({ db: { type: "local" }, docs: { type: "remote" } });
      expect(project.plugin).toEqual(["p1", "p2"]);
    });

    it("reads sub-agents from .opencode/agent, with their description and model", async () => {
      write(
        join(repo, ".opencode", "agent", "reviewer.md"),
        "---\ndescription: Reviews the diff\nmodel: acme/small\n---\nReview the diff.\n",
      );
      write(join(repo, ".opencode", "agent", "terse.md"), "---\nmodel: acme/tiny\n---\nBe brief.");
      write(join(repo, ".opencode", "agent", "empty.md"), "---\ndescription: No body\n---\n   ");
      write(join(repo, ".opencode", "agent", "notes.txt"), "not an agent");
      const project = await opencodeProject(repo);
      expect(project.agents).toEqual({
        reviewer: {
          description: "Reviews the diff",
          prompt: "Review the diff.",
          model: "acme/small",
        },
        terse: { description: "terse", prompt: "Be brief.", model: "acme/tiny" },
      });
    });

    it("lists the instruction files that exist, as absolute paths", async () => {
      write(join(repo, "AGENTS.md"), "Agents.");
      write(join(repo, "CLAUDE.md"), "Claude.");
      const project = await opencodeProject(repo);
      expect(project.instructions.map((path) => basename(path))).toEqual([
        "AGENTS.md",
        "CLAUDE.md",
      ]);
      expect(project.instructions.every((path) => isAbsolute(path))).toBe(true);
    });

    it("lists only the skill folders that exist", async () => {
      write(join(repo, ".claude", "skills", "probe", "SKILL.md"), "x");
      mkdirSync(join(repo, ".agents", "skills"), { recursive: true });
      const project = await opencodeProject(repo);
      expect(
        project.skillPaths.map((path) => slashed(path).split("/").slice(-2).join("/")),
      ).toEqual([".claude/skills", ".agents/skills"]);
    });

    it("is empty for a repo without any of it", async () => {
      expect(await opencodeProject(repo)).toEqual({
        agents: {},
        instructions: [],
        skillPaths: [],
        mcp: {},
        plugin: [],
      });
    });
  });
});
