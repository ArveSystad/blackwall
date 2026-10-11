import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildReason, serverArgs } from "./start.js";

const OUTPUTS = [
  "packages/shared/dist/index.js",
  "packages/core/dist/index.js",
  "packages/integrations/dist/index.js",
  "apps/server/dist/index.js",
  "apps/web/dist/index.html",
  "apps/desktop/dist/main.js",
];

describe("serverArgs", () => {
  it("drops the leading -- that pnpm forwards", () => {
    expect(serverArgs(["--", "--no-open", "--port", "5000"])).toEqual([
      "--no-open",
      "--port",
      "5000",
    ]);
  });

  it("keeps args given without a separator", () => {
    expect(serverArgs(["--no-open"])).toEqual(["--no-open"]);
    expect(serverArgs([])).toEqual([]);
  });
});

describe("buildReason", () => {
  let root;
  const past = new Date("2026-01-01T00:00:00Z");
  const later = new Date("2026-01-02T00:00:00Z");

  function write(file, time = past) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    utimesSync(path, time, time);
  }

  function writeBuilt() {
    for (const file of OUTPUTS) write(file, later);
    write("apps/server/dist/.build-stamp", later);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "blackwall-start-"));
    write("package.json");
    write("packages/core/src/index.ts");
    write("apps/web/index.html");
    for (const workspace of [
      "packages/shared",
      "packages/integrations",
      "apps/server",
      "apps/desktop",
    ]) {
      write(`${workspace}/package.json`);
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports missing output when nothing is built", () => {
    expect(buildReason(root)).toBe("missing");
  });

  it("reports missing output when the stamp exists but an output does not", () => {
    writeBuilt();
    rmSync(join(root, "apps/web/dist/index.html"));
    expect(buildReason(root)).toBe("missing");
  });

  it("is current when every input predates the stamp", () => {
    writeBuilt();
    expect(buildReason(root)).toBeNull();
  });

  it("reports stale output when a source file changed after the build", () => {
    writeBuilt();
    write("packages/core/src/index.ts", new Date("2026-01-03T00:00:00Z"));
    expect(buildReason(root)).toBe("stale");
  });

  it("reports stale output when a workspace config file changed after the build", () => {
    writeBuilt();
    write("apps/web/index.html", new Date("2026-01-03T00:00:00Z"));
    expect(buildReason(root)).toBe("stale");
  });

  it("ignores changes under dist and node_modules", () => {
    writeBuilt();
    write("packages/core/src/node_modules/x.js", new Date("2026-01-03T00:00:00Z"));
    write("apps/server/dist/extra.js", new Date("2026-01-03T00:00:00Z"));
    expect(buildReason(root)).toBeNull();
  });
});
