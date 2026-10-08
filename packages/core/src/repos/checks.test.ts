import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { suggestCheckCommands } from "./checks.js";

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
