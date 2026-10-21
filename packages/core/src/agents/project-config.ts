import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { isObject, type Json } from "./adapters/json.js";
import type { OpencodeProject } from "./permissions.js";

/*
 * What a Trusted run reads from the repo itself: its skills, sub-agents,
 * instruction files, MCP servers and hooks. Reads stay inside the working
 * directory; a symlink pointing outside it is skipped, and a file that is
 * missing or malformed is treated as absent.
 */

/** Instruction files are capped, like the chat's focused-task sections. */
const MAX_INSTRUCTIONS_CHARS = 40_000;
/** Files copied into the Claude plugin, at most. */
const MAX_PLUGIN_FILES = 2_000;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The real path of `rel` under `cwd` when it exists and stays inside it. */
async function resolveInside(cwd: string, rel: string): Promise<string | undefined> {
  try {
    const root = await realpath(cwd);
    const real = await realpath(join(cwd, rel));
    return inside(root, real) ? real : undefined;
  } catch {
    return undefined;
  }
}

async function fileInside(cwd: string, rel: string): Promise<string | undefined> {
  const path = await resolveInside(cwd, rel);
  return path && (await stat(path)).isFile() ? path : undefined;
}

async function dirInside(cwd: string, rel: string): Promise<string | undefined> {
  const path = await resolveInside(cwd, rel);
  return path && (await stat(path)).isDirectory() ? path : undefined;
}

/** The index just past the string literal starting at `start`. */
function stringEnd(text: string, start: number): number {
  let j = start + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** JSON with comments and trailing commas (JSONC) as plain JSON; strings are left alone. */
export function stripJsonc(text: string): string {
  let plain = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const end = stringEnd(text, i);
      plain += text.slice(i, end);
      i = end - 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      plain += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      plain += c;
    }
  }
  let out = "";
  for (let i = 0; i < plain.length; i++) {
    const c = plain[i]!;
    if (c === '"') {
      const end = stringEnd(plain, i);
      out += plain.slice(i, end);
      i = end - 1;
    } else if (c !== "," || !/^\s*[}\]]/.test(plain.slice(i + 1))) {
      out += c;
    }
  }
  return out;
}

/** A JSON or JSONC file inside `cwd`, or undefined when missing or malformed. */
async function readJson(cwd: string, rel: string): Promise<unknown> {
  const path = await fileInside(cwd, rel);
  if (!path) return undefined;
  try {
    return JSON.parse(stripJsonc(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

/** The repo's MCP config (`.mcp.json`) and its server names, when it has any servers. */
export async function projectMcp(
  cwd: string,
): Promise<{ path: string; servers: string[] } | undefined> {
  const config = await readJson(cwd, ".mcp.json");
  if (!isObject(config) || !isObject(config.mcpServers)) return undefined;
  const servers = Object.keys(config.mcpServers).filter((name) => /^[\w.-]+$/.test(name));
  const path = await fileInside(cwd, ".mcp.json");
  return path && servers.length > 0 ? { path, servers } : undefined;
}

/** The `hooks` of the repo's `.claude/settings.json`, if any. */
export async function claudeProjectHooks(cwd: string): Promise<Json | undefined> {
  const settings = await readJson(cwd, join(".claude", "settings.json"));
  return isObject(settings) && isObject(settings.hooks) ? settings.hooks : undefined;
}

/**
 * The repo's Claude instruction files (`CLAUDE.md`, `.claude/CLAUDE.md`), as
 * a section for the system prompt: `--restricted` never loads them itself.
 */
export async function claudeProjectInstructions(cwd: string): Promise<string | undefined> {
  const parts: string[] = [];
  for (const rel of ["CLAUDE.md", join(".claude", "CLAUDE.md")]) {
    const path = await fileInside(cwd, rel);
    if (!path) continue;
    const text = (await readFile(path, "utf8").catch(() => "")).trim();
    if (text) parts.push(`### ${rel.replace(/\\/g, "/")}\n\n${text}`);
  }
  if (parts.length === 0) return undefined;
  const body = parts.join("\n\n");
  const capped =
    body.length > MAX_INSTRUCTIONS_CHARS ? `${body.slice(0, MAX_INSTRUCTIONS_CHARS)}\n…` : body;
  return `## The repository's own instructions\n\n${capped}`;
}

/** The harness plugin's name; Claude Code names its skills and agents `<plugin>:<name>`. */
export const CLAUDE_PROJECT_PLUGIN = "blackwall-project";

/** A per-run plugin directory; `dispose` removes it. */
export interface ProjectPlugin {
  dir: string;
  dispose: () => Promise<void>;
}

/**
 * Copies `from` into `to`, following only symlinks that stay inside `root`
 * and stopping at {@link MAX_PLUGIN_FILES}. Returns the files copied.
 */
async function copyInside(root: string, from: string, to: string, budget: { left: number }) {
  let copied = 0;
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (budget.left <= 0) break;
    let source = join(from, entry.name);
    if (entry.isSymbolicLink()) {
      const real = await realpath(source).catch(() => undefined);
      if (!real || !inside(root, real)) continue;
      source = real;
    }
    const info = await stat(source).catch(() => undefined);
    if (info?.isDirectory()) {
      copied += await copyInside(root, source, join(to, entry.name), budget);
    } else if (info?.isFile()) {
      await copyFile(source, join(to, entry.name));
      budget.left--;
      copied++;
    }
  }
  return copied;
}

/**
 * A Claude Code plugin holding copies of the repo's skills (`.claude/skills`)
 * and sub-agents (`.claude/agents/*.md`), loaded with `--plugin-dir` so that
 * `--restricted` runs get them without the repo's `settings.json`. Undefined
 * when the repo has neither.
 */
export async function prepareClaudeProjectPlugin(
  cwd: string,
  root: string = tmpdir(),
): Promise<ProjectPlugin | undefined> {
  const skills = await dirInside(cwd, join(".claude", "skills"));
  const agents = await dirInside(cwd, join(".claude", "agents"));
  if (!skills && !agents) return undefined;
  const repo = await realpath(cwd);
  const dir = await mkdtemp(join(root, "blackwall-claude-"));
  const dispose = () => rm(dir, { recursive: true, force: true });
  try {
    const budget = { left: MAX_PLUGIN_FILES };
    let copied = 0;
    if (skills) copied += await copyInside(repo, skills, join(dir, "skills"), budget);
    if (agents) {
      await mkdir(join(dir, "agents"));
      for (const entry of await readdir(agents)) {
        if (extname(entry) !== ".md") continue;
        const path = await fileInside(cwd, join(".claude", "agents", entry));
        if (!path) continue;
        await copyFile(path, join(dir, "agents", entry));
        copied++;
      }
    }
    if (copied === 0) {
      await dispose();
      return undefined;
    }
    await mkdir(join(dir, ".claude-plugin"));
    await writeFile(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: CLAUDE_PROJECT_PLUGIN,
        description: "The repository's own skills and agents",
      }),
    );
  } catch (error) {
    await dispose();
    throw error;
  }
  return { dir, dispose };
}

/** The top-level `key: value` pairs of a Markdown file's YAML frontmatter, and its body. */
export function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?(?:\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    fields[pair[1]!] = pair[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { fields, body: match[2]! };
}

/** OpenCode's project config files, both places and both syntaxes. */
const OPENCODE_CONFIG_FILES = [
  "opencode.json",
  "opencode.jsonc",
  join(".opencode", "opencode.json"),
  join(".opencode", "opencode.jsonc"),
];

const OPENCODE_AGENT_DIRS = [join(".opencode", "agent"), join(".opencode", "agents")];

/** Skill folders OpenCode reads in a project, besides the user's own. */
const OPENCODE_SKILL_DIRS = [
  join(".opencode", "skill"),
  join(".opencode", "skills"),
  join(".claude", "skills"),
  join(".agents", "skills"),
];

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

/**
 * What a Trusted OpenCode run takes from the repo, read here because the run
 * disables the project's own config: the `mcp` and `plugin` entries of its
 * config, its sub-agents, its instruction files and its skill folders.
 */
export async function opencodeProject(cwd: string): Promise<OpencodeProject> {
  const mcp: Record<string, unknown> = {};
  const plugin: string[] = [];
  for (const rel of OPENCODE_CONFIG_FILES) {
    const config = await readJson(cwd, rel);
    if (!isObject(config)) continue;
    if (isObject(config.mcp)) Object.assign(mcp, config.mcp);
    if (Array.isArray(config.plugin)) {
      plugin.push(...config.plugin.filter((p): p is string => typeof p === "string"));
    }
  }
  const agents: OpencodeProject["agents"] = {};
  for (const rel of OPENCODE_AGENT_DIRS) {
    const dir = await dirInside(cwd, rel);
    if (!dir) continue;
    for (const entry of await readdir(dir)) {
      if (extname(entry) !== ".md") continue;
      const path = await fileInside(cwd, join(rel, entry));
      if (!path) continue;
      const { fields, body } = frontmatter(await readFile(path, "utf8"));
      const name = basename(entry, ".md");
      if (!/^[\w.-]+$/.test(name) || !body.trim()) continue;
      agents[name] = {
        description: fields.description || name,
        prompt: body.trim(),
        ...(fields.model ? { model: fields.model } : {}),
      };
    }
  }
  const instructions: string[] = [];
  for (const rel of INSTRUCTION_FILES) {
    const path = await fileInside(cwd, rel);
    if (path) instructions.push(path);
  }
  const skillPaths: string[] = [];
  for (const rel of OPENCODE_SKILL_DIRS) {
    const path = await dirInside(cwd, rel);
    if (path) skillPaths.push(path);
  }
  return { agents, instructions, skillPaths, mcp, plugin: [...new Set(plugin)] };
}
