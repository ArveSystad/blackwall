import { defineConfig } from "vitest/config";

// Workspace packages expose a "source" export condition pointing at src/,
// so tests run against TypeScript sources without a prior build.
const projects = [
  "packages/shared",
  "packages/core",
  "packages/integrations",
  "apps/server",
  "apps/web",
  "apps/desktop",
  "scripts",
];

export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    // Many tests drive real git repos (clone, rebase, push), which on Windows
    // can pass vitest's 5s default when the whole suite runs in parallel.
    testTimeout: 20_000,
    projects: projects.map((root) => ({
      extends: true,
      test: { name: root.split("/").at(-1), root },
    })),
  },
});
