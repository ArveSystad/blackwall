---
id: task-001
title: Monorepo scaffold
status: backlog
depends_on: []
---

## Goal
Set up the pnpm workspace that everything else builds on.

## Scope
- pnpm workspaces: `apps/server`, `apps/web`, `packages/core`, `packages/integrations`, `packages/shared`.
- TypeScript strict with a shared `tsconfig.base.json`.
- ESLint + Prettier; Vitest at the root in workspace mode.
- `.gitignore`, `.editorconfig`, `engines: node >= 22`, `git init`.
- Root scripts: `dev`, `build`, `test`, `lint`, `start` (start is fleshed out in task-023).

## Acceptance criteria
- `pnpm install && pnpm build && pnpm test && pnpm lint` passes on Windows and macOS/Linux.
- Each package exports a trivial symbol consumed by another, to prove the wiring.

## Refs
grill-result.md §9

## Notes
- TypeScript pinned to ~6.0 because typescript-eslint 8.x supports `<6.1`; revisit TS 7 when it does.
- Workspace packages export a `source` condition (`./src/index.ts`). Vitest, Vite and `tsx --conditions=source` resolve sources directly, so tests and dev need no prior build; `tsc -b` uses `dist` via project references.
- pnpm 11 blocks dependency build scripts; allowed ones are listed under `allowBuilds` in `pnpm-workspace.yaml` (esbuild for now; better-sqlite3 and @napi-rs/keyring will need adding).
- Existing git repo had branch `master` with no commits; renamed to `main`.
