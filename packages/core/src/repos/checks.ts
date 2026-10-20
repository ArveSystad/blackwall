import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** `package.json` scripts suggested as checks, in the order they run. */
const NODE_CHECK_SCRIPTS = ["build", "typecheck", "lint", "test"] as const;

const PACKAGE_MANAGERS = ["pnpm", "yarn", "bun", "npm"] as const;
type PackageManager = (typeof PACKAGE_MANAGERS)[number];

const LOCKFILES: readonly [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

interface PackageJson {
  packageManager?: unknown;
  scripts?: unknown;
}

function packageManager(pkg: PackageJson, files: ReadonlySet<string>): PackageManager {
  if (typeof pkg.packageManager === "string") {
    const declared = pkg.packageManager.split("@")[0];
    const known = PACKAGE_MANAGERS.find((pm) => pm === declared);
    if (known) return known;
  }
  return LOCKFILES.find(([file]) => files.has(file))?.[1] ?? "npm";
}

async function nodeChecks(path: string, files: ReadonlySet<string>): Promise<string[]> {
  if (!files.has("package.json")) return [];
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as PackageJson;
  } catch {
    return [];
  }
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const pm = packageManager(pkg, files);
  return NODE_CHECK_SCRIPTS.filter(
    (script) => typeof Reflect.get(scripts, script) === "string",
  ).map((script) => `${pm} run ${script}`);
}

function quote(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/**
 * The solution, else the project, `dotnet` should be given: it needs the file
 * named when a folder holds several solutions or projects.
 */
function dotnetTarget(names: readonly string[]): string | undefined {
  return names.find((f) => /\.slnx?$/i.test(f)) ?? names.find((f) => /\.(cs|fs|vb)proj$/i.test(f));
}

function dotnetChecks(names: readonly string[]): string[] {
  const target = dotnetTarget(names);
  if (!target) return [];
  return [`dotnet build ${quote(target)}`, `dotnet test ${quote(target)}`];
}

/** Sorted names of the files directly in `path`; empty when it can't be read. */
async function topLevelFiles(path: string): Promise<string[]> {
  return (await readdir(path, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Check commands suggested from a repo's top-level build files: `package.json`
 * scripts (run with the repo's package manager), `*.sln`/`*.csproj`,
 * `Cargo.toml`, `go.mod` and `pom.xml`. Empty when nothing is recognised.
 */
export async function suggestCheckCommands(path: string): Promise<string[]> {
  const names = await topLevelFiles(path);
  const files = new Set(names);
  return [
    ...(await nodeChecks(path, files)),
    ...dotnetChecks(names),
    ...(files.has("Cargo.toml") ? ["cargo build", "cargo test"] : []),
    ...(files.has("go.mod") ? ["go build ./...", "go test ./..."] : []),
    ...(files.has("pom.xml") ? ["mvn -B verify"] : []),
  ];
}

/**
 * Setup commands the harness can suggest, each with the lockfiles (git
 * pathspec names, matched at any depth) whose contents decide when it must run
 * again. The Node commands are the frozen variants, so setup never rewrites a
 * lockfile the harness would then commit.
 */
export const SETUP_SUGGESTIONS: readonly { command: string; lockfiles: readonly string[] }[] = [
  { command: "pnpm install --frozen-lockfile", lockfiles: ["pnpm-lock.yaml"] },
  { command: "yarn install --frozen-lockfile", lockfiles: ["yarn.lock"] },
  { command: "npm ci", lockfiles: ["package-lock.json"] },
  { command: "dotnet restore", lockfiles: ["packages.lock.json", "*.csproj"] },
  { command: "go mod download", lockfiles: ["go.sum"] },
];

/**
 * Every lockfile of {@link SETUP_SUGGESTIONS}. The setup key hashes these
 * whatever commands the user typed.
 */
export const SETUP_LOCKFILES: readonly string[] = [
  ...new Set(SETUP_SUGGESTIONS.flatMap((suggestion) => suggestion.lockfiles)),
];

/** The suggested Node install command, by the same lockfile precedence as the checks. */
const NODE_SETUP: readonly [string, string][] = [
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["yarn.lock", "yarn install --frozen-lockfile"],
  ["package-lock.json", "npm ci"],
];

/**
 * Setup (dependency install) commands suggested from a repo's top-level
 * lockfiles: one Node install, `dotnet restore` (naming the solution or
 * project) and `go mod download`. Empty when nothing is recognised.
 */
export async function suggestSetupCommands(path: string): Promise<string[]> {
  const names = await topLevelFiles(path);
  const files = new Set(names);
  const node = NODE_SETUP.find(([lockfile]) => files.has(lockfile))?.[1];
  const target = dotnetTarget(names);
  const dotnet = target !== undefined || files.has("packages.lock.json");
  return [
    ...(node ? [node] : []),
    ...(dotnet ? [target ? `dotnet restore ${quote(target)}` : "dotnet restore"] : []),
    ...(files.has("go.sum") ? ["go mod download"] : []),
  ];
}
