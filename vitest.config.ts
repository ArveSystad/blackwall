import { defineConfig } from "vitest/config";

// Workspace packages expose a "source" export condition pointing at src/,
// so tests run against TypeScript sources without a prior build.
const projects = [
  "packages/shared",
  "packages/core",
  "packages/integrations",
  "apps/server",
  "apps/web",
  "scripts",
];

export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    projects: projects.map((root) => ({
      extends: true,
      test: { name: root.split("/").at(-1), root },
    })),
  },
});
