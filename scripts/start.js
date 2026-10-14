// `pnpm start`: builds the workspace when its output is missing or stale, then runs the server
// in this process. Arguments (`--no-open`, `--port <n>`) are passed through to the server.
// `ensureBuilt()` is shared with `pnpm desktop` (scripts/desktop.js).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACES = [
  "packages/shared",
  "packages/core",
  "packages/integrations",
  "apps/server",
  "apps/web",
  "apps/desktop",
];
const ROOT_INPUTS = ["package.json", "pnpm-lock.yaml", "tsconfig.json", "tsconfig.base.json"];
const SERVER_ENTRY = "apps/server/dist/index.js";
/** Touched after every successful build; sources newer than this mean the build is stale. */
const STAMP = "apps/server/dist/.build-stamp";
const OUTPUTS = [
  "packages/shared/dist/index.js",
  "packages/core/dist/index.js",
  "packages/integrations/dist/index.js",
  SERVER_ENTRY,
  "apps/web/dist/index.html",
  "apps/desktop/dist/main.js",
];
const IGNORED_DIRS = new Set(["node_modules", "dist", "coverage", ".vite"]);

/** Drops the `--` separator pnpm forwards for `pnpm start -- --no-open`. */
export function serverArgs(argv) {
  return argv[0] === "--" ? argv.slice(1) : [...argv];
}

function newestMtime(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    newest = Math.max(newest, newestMtime(join(path, entry.name)));
  }
  return newest;
}

/** Build inputs: root config plus each workspace's sources and top-level config files. */
function inputPaths(root) {
  const paths = ROOT_INPUTS.map((file) => join(root, file));
  for (const workspace of WORKSPACES) {
    const dir = join(root, workspace);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() ? entry.name === "src" : !entry.name.endsWith(".tsbuildinfo")) {
        paths.push(join(dir, entry.name));
      }
    }
  }
  return paths.filter((path) => existsSync(path));
}

/** Why a build is needed (`missing` or `stale`), or `null` when the output is current. */
export function buildReason(root = ROOT) {
  const stamp = join(root, STAMP);
  if (!existsSync(stamp) || OUTPUTS.some((file) => !existsSync(join(root, file)))) return "missing";
  const built = statSync(stamp).mtimeMs;
  return inputPaths(root).some((path) => newestMtime(path) > built) ? "stale" : null;
}

function build() {
  // `shell` resolves pnpm's .cmd shim on Windows.
  const result = spawnSync("pnpm build", { cwd: ROOT, stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.error("Build failed; not starting blackwall.");
    process.exit(result.status ?? 1);
  }
  markBuilt();
}

/** Records a successful build, so later launches only rebuild when sources change again. */
export function markBuilt(root = ROOT) {
  writeFileSync(join(root, STAMP), `${new Date().toISOString()}\n`);
}

/** Builds the workspace when its output is missing or stale; exits the process if the build fails. */
export function ensureBuilt() {
  const reason = buildReason();
  if (reason) {
    console.log(`Build output is ${reason}; building...`);
    build();
  }
}

async function main() {
  ensureBuilt();
  const entry = join(ROOT, SERVER_ENTRY);
  // The server reads its flags from process.argv.slice(2).
  process.argv = [process.argv[0], entry, ...serverArgs(process.argv.slice(2))];
  await import(pathToFileURL(entry).href);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
