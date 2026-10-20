import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SETUP_LOCKFILES,
  SETUP_SUGGESTIONS,
  suggestCheckCommands,
  suggestSetupCommands,
} from "./checks.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blackwall-checks-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, content = "") {
  writeFileSync(join(dir, name), content);
}

function packageJson(fields: Record<string, unknown>) {
  write("package.json", JSON.stringify(fields));
}

describe("suggestCheckCommands", () => {
  it("suggests package.json check scripts in order with the lockfile's package manager", async () => {
    packageJson({ scripts: { test: "vitest", dev: "vite", lint: "eslint .", build: "tsc" } });
    write("pnpm-lock.yaml");
    expect(await suggestCheckCommands(dir)).toEqual([
      "pnpm run build",
      "pnpm run lint",
      "pnpm run test",
    ]);
  });

  it("prefers the packageManager field and defaults to npm", async () => {
    packageJson({ packageManager: "yarn@4.5.0", scripts: { test: "jest" } });
    write("package-lock.json");
    expect(await suggestCheckCommands(dir)).toEqual(["yarn run test"]);
    packageJson({ scripts: { typecheck: "tsc --noEmit" } });
    expect(await suggestCheckCommands(dir)).toEqual(["npm run typecheck"]);
  });

  it("ignores an unreadable package.json", async () => {
    write("package.json", "{ not json");
    expect(await suggestCheckCommands(dir)).toEqual([]);
  });

  it("names the .NET solution, preferring it over projects", async () => {
    write("App.csproj");
    write("My App.sln");
    expect(await suggestCheckCommands(dir)).toEqual([
      'dotnet build "My App.sln"',
      'dotnet test "My App.sln"',
    ]);
  });

  it("recognises Cargo, Go and Maven builds", async () => {
    write("Cargo.toml");
    write("go.mod");
    write("pom.xml");
    expect(await suggestCheckCommands(dir)).toEqual([
      "cargo build",
      "cargo test",
      "go build ./...",
      "go test ./...",
      "mvn -B verify",
    ]);
  });

  it("only looks at top-level files", async () => {
    mkdirSync(join(dir, "Cargo.toml"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "go.mod"), "");
    expect(await suggestCheckCommands(dir)).toEqual([]);
    expect(await suggestCheckCommands(join(dir, "missing"))).toEqual([]);
  });
});

describe("suggestSetupCommands", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["yarn.lock", "yarn install --frozen-lockfile"],
    ["package-lock.json", "npm ci"],
    ["App.csproj", "dotnet restore App.csproj"],
    ["packages.lock.json", "dotnet restore"],
    ["go.sum", "go mod download"],
  ])("suggests a command for %s", async (lockfile, command) => {
    write(lockfile);
    expect(await suggestSetupCommands(dir)).toEqual([command]);
  });

  it("suggests one Node install, preferring pnpm, then yarn", async () => {
    write("package-lock.json");
    write("yarn.lock");
    expect(await suggestSetupCommands(dir)).toEqual(["yarn install --frozen-lockfile"]);
    write("pnpm-lock.yaml");
    write("go.sum");
    expect(await suggestSetupCommands(dir)).toEqual([
      "pnpm install --frozen-lockfile",
      "go mod download",
    ]);
  });

  it("names the .NET solution when there are several", async () => {
    write("App.csproj");
    write("My App.sln");
    write("Other.sln");
    write("packages.lock.json");
    expect(await suggestSetupCommands(dir)).toEqual(['dotnet restore "My App.sln"']);
  });

  it("only looks at top-level files", async () => {
    mkdirSync(join(dir, "go.sum"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "pnpm-lock.yaml"), "");
    expect(await suggestSetupCommands(dir)).toEqual([]);
    expect(await suggestSetupCommands(join(dir, "missing"))).toEqual([]);
  });

  it("suggests nothing for an empty folder", async () => {
    expect(await suggestSetupCommands(dir)).toEqual([]);
  });

  it("keys setup on the lockfiles of every suggestion", () => {
    for (const { lockfiles } of SETUP_SUGGESTIONS) {
      for (const lockfile of lockfiles) expect(SETUP_LOCKFILES).toContain(lockfile);
    }
    expect(new Set(SETUP_LOCKFILES).size).toBe(SETUP_LOCKFILES.length);
  });
});
