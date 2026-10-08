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

/** `dotnet` needs the file named when a folder holds several solutions or projects. */
function dotnetChecks(files: readonly string[]): string[] {
  const target =
    files.find((f) => /\.slnx?$/i.test(f)) ?? files.find((f) => /\.(cs|fs|vb)proj$/i.test(f));
  if (!target) return [];
  return [`dotnet build ${quote(target)}`, `dotnet test ${quote(target)}`];
}

/**
 * Check commands suggested from a repo's top-level build files: `package.json`
 * scripts (run with the repo's package manager), `*.sln`/`*.csproj`,
 * `Cargo.toml`, `go.mod` and `pom.xml`. Empty when nothing is recognised.
 */
export async function suggestCheckCommands(path: string): Promise<string[]> {
  const names = (await readdir(path, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const files = new Set(names);
  return [
    ...(await nodeChecks(path, files)),
    ...dotnetChecks(names),
    ...(files.has("Cargo.toml") ? ["cargo build", "cargo test"] : []),
    ...(files.has("go.mod") ? ["go build ./...", "go test ./..."] : []),
    ...(files.has("pom.xml") ? ["mvn -B verify"] : []),
  ];
}
