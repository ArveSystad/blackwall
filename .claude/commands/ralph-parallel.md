---
name: ralph-parallel
description: 'Run multiple backlog tasks concurrently, each in its own isolated git worktree and branch, driven by sub-agents the orchestrator dispatches and merges back to main. Use when the user says "ralph parallel", "run tasks in parallel", "parallel ralph", or asks for multiple agents/worktrees working the backlog at once.'
argument-hint: 'Optional: "<total> <concurrency>" e.g. "9 3" (default: drain backlog, concurrency 3)'
---

# Ralph Parallel Loop

## Communication style

Follow the `caveman` skill for narration and status updates while running this — terse, no filler. Pass this instruction on to each spawned sub-agent too. Code, task plans, plans, and commit/PR text stay normal prose (caveman's own boundaries).

## When to Use

- User says "ralph parallel", "run N tasks in parallel", "parallel ralph", or asks for multiple worktrees/agents working the backlog concurrently
- The sequential `ralph` skill is too slow for the amount of independent backlog work available

## Relationship to `ralph`

This is a separate skill from `ralph`. `ralph` stays strictly sequential (one agent, no worktrees) — use it when isolation isn't needed. This skill trades some determinism (batching, local-only merges) for throughput. Do not mix the two in the same run.

## Core Design

- **You (the orchestrating session) never delegate coordination.** You claim tasks, create worktrees, dispatch sub-agents, merge results, and update `tasks/done.md` yourself. Sub-agents only implement — they never touch `tasks/backlog/`, never touch `tasks/done.md`, and never merge or push.
- **Claiming happens on `main`, before any worktree is created**, and is committed as a single commit per batch. This is what prevents two concurrent sub-agents from ever picking the same task — each worktree branches off `main` *after* the claim commit, so a claimed task is simply absent from that worktree's `tasks/backlog/`.
- **Concurrency is realized as fixed-size batches**, not a rolling pool: launch up to `concurrency` sub-agents together in a single message (so they truly run in parallel), wait for the whole batch, process/merge results, then start the next batch. A fast task in a batch still waits for the slowest one in the same batch — this keeps coordination simple and deterministic instead of needing async polling.
- **`tasks/done.md` is written only by the orchestrator**, after a successful merge, never by a sub-agent. This is the key trick that avoids every parallel branch fighting over the same sequential-number line.
- **Nothing is ever pushed to `origin`.** Everything lands on local `main` only — the user pushes when ready. If you think auto-push is wanted, ask first; don't assume it.

## Procedure

### 0. Parse Arguments

- No argument: `total = unlimited` (drain the backlog), `concurrency = 3`
- One number `N`: `total = N`, `concurrency = 3`
- Two numbers `N C`: `total = N`, `concurrency = C`
- Track `remaining` = `total` (or unlimited) across the whole run.

### 1. Claim a Batch

`batchSize = min(concurrency, remaining)` (or just `concurrency` if `total` is unlimited).

First, `mkdir -p tasks/in-progress` — git doesn't track empty directories, so once a previous batch's `tasks/in-progress/` empties out (everything merged into `tasks/done/`), git silently drops the directory itself, and the next `git mv` into it fails with "No such file or directory". Recreating it is a harmless no-op when it already exists.

Repeat up to `batchSize` times, in the **main repo working directory** (never inside a worktree):

```bash
task=$(pwsh -File tasks/pick-next-task.ps1)
```

- Exit 1 on the **first** attempt of the batch → backlog is empty or all remaining tasks are blocked. Print "Backlog is empty — ralph-parallel complete." and stop the whole loop.
- Exit 1 on a **later** attempt within the batch → just means fewer than `batchSize` tasks are claimable right now; stop claiming for this batch and proceed with however many were claimed.
- Exit 0 → claim it:
  ```bash
  git mv "tasks/backlog/$task" "tasks/in-progress/$task"
  ```
  Add `$task` to this batch's claimed list. Re-running the picker immediately after is safe — it reads the live filesystem, and the file is no longer in `tasks/backlog/`.

Once claiming for the batch is done, commit **once** for the whole batch:

```bash
git add tasks/backlog tasks/in-progress
git commit -m "chore(tasks): claim <task-1>, <task-2>, ... for parallel batch"
```

This commit must exist before any worktree in step 2 is created, or the worktrees won't see the claim.

### 2. Create a Worktree + Branch per Claimed Task

For each task in the batch (slug = filename without `.md`):

```bash
git worktree add "../joinin-worktrees/<slug>" -b "ralph-parallel/<slug>" HEAD
```

`HEAD` here is the post-claim-commit `main` tip, so every worktree in the batch starts from an identical, consistent view of `tasks/`.

### 3. Dispatch Sub-Agents — All in One Message

Launch one Agent tool call per claimed task, **all as separate tool-use blocks in the same message**, so they execute concurrently. Each agent starts fresh (no shared context) — the prompt must be fully self-contained. Use this template per task, substituting `<worktree-path>`, `<branch>`, and `<task-file>`:

> You are working on the JoinIn codebase (an ASP.NET 10 + React/Vite event-hosting platform). Your entire working area is the git worktree at `<worktree-path>`, already checked out on branch `<branch>`. **Do all your work inside that worktree** — use absolute paths under `<worktree-path>` for every file read/write/edit/glob, and `cd "<worktree-path>"` (or an equivalent absolute-path prefix) for every shell command. Never touch any other directory, and never run `git push`, `git merge`, or anything that touches a branch other than `<branch>`.
>
> A task has already been claimed for you and moved to `<worktree-path>/tasks/in-progress/<task-file>`. Your job is to implement it fully and commit the result on this branch. Steps, in order:
>
> 1. Read the full task file before writing any code.
> 2. Break the work into a checklist and save it as `<worktree-path>/tasks/in-progress/<task-file>.plan.md`, so progress survives a context reset.
> 3. Implement the task fully, following the conventions in `.github/copilot-instructions.md` and `.github/design.md` (paths relative to the worktree root).
> 4. When implementation is complete (and verified — run the relevant build/tests), move the task file: `git mv tasks/in-progress/<task-file> tasks/done/<task-file>`, then delete the `.plan.md` file. **Do not edit `tasks/done.md`** — the orchestrator updates it centrally after merging, to avoid every parallel branch colliding on the same line.
> 5. Commit everything (implementation + the task file move), Conventional Commits style (`fix|feat|perf|refactor|test|chore(<scope>): <summary>`), each commit ending with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. Do not push.
> 6. If you start any dev servers, docker/test containers, watch processes, or other background processes during verification, fully stop/kill every one of them before finishing — a leftover process holding a lock inside this worktree will make the orchestrator's cleanup (`git worktree remove`) fail with "Device or resource busy". Double-check with a process listing before you report done.
> 7. Finish your final message with either:
>    - `SUCCESS: <one past-tense sentence summarizing what was delivered>` (this sentence will be appended to `tasks/done.md` verbatim-ish, so make it read like the existing entries there), or
>    - `FAILURE: <what went wrong and how far you got>` if you got stuck or the task turned out unimplementable as written. Don't leave a half-finished implementation uncommitted — commit whatever partial progress exists so it can be inspected, then report FAILURE.

Wait for the message to complete — all tool results in the batch return together.

### 4. Process Each Result (in claim order)

Back in the **main repo working directory**, for each task in the batch, read the agent's final message for `SUCCESS:` / `FAILURE:`:

**On `SUCCESS:`**

```bash
git merge --no-ff "ralph-parallel/<slug>" -m "merge(tasks): <task-file> (parallel agent)"
```

- **Merge succeeds:** read `tasks/done.md`, find the current highest `N.` entry, append `<N+1>. <agent's summary sentence>` at the end of the file, then commit: `git commit -m "chore(tasks): log completion of <task-file>"`. Then clean up:
  ```bash
  git worktree remove "../joinin-worktrees/<slug>"
  git branch -d "ralph-parallel/<slug>"
  ```
  If `git worktree remove` fails with "Device or resource busy" (a leftover process still has a handle open in that directory, e.g. an un-killed dev server), find and kill it — e.g. via `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*<slug>*" }` in PowerShell — then retry the remove. Don't `rm -rf` past a busy handle; kill the process first.
- **Merge conflicts:** `git merge --abort`. Do **not** unclaim the task — real, committed work exists on the branch and in `tasks/in-progress/`. Remove just the worktree (`git worktree remove "../joinin-worktrees/<slug>"`), keep the branch, and record this as a **failure** for reporting/halting purposes below.

**On `FAILURE:`**

```bash
git worktree remove "../joinin-worktrees/<slug>" --force
git mv "tasks/in-progress/<task-file>" "tasks/backlog/<task-file>"
git commit -m "chore(tasks): unclaim <task-file> after failed parallel attempt"
```

Keep the branch (`ralph-parallel/<slug>`) around — it holds whatever partial commits the agent made, for manual inspection. Record as a failure.

### 5. Report the Batch

One line per task:

- `✓ <task-file>: <summary>`
- `✗ <task-file>: <failure reason> (branch preserved: ralph-parallel/<slug>)`

### 6. Decide Whether to Continue

- **Any failure or merge conflict in the batch** → halt the whole loop here (mirrors `ralph`'s "halt on error" behavior). Report clearly which tasks succeeded, which failed, and which branches were preserved for manual follow-up. Do not start the next batch.
- **Whole batch succeeded** → if `total` was finite, subtract the batch size from `remaining`; if `remaining <= 0`, stop and report completion. Otherwise go back to step 1 for the next batch.
- Also stop if the user manually interrupts.

## Notes

- Reuses `tasks/pick-next-task.ps1` for claiming — identical priority (`simple-*` > `standalone-*` > `bugfix-*` > `perf-*` > `sec-*` > everything else) and dependency rules as `ralph`/`start-task`. A dependency is satisfied once its task file exists in `tasks/done/` — since the orchestrator merges to `main` (and merges are what update `tasks/done/`) before starting the next batch, cross-task dependencies resolve correctly between batches, never within one.
- Worktrees live in `../joinin-worktrees/<slug>`, a sibling of the repo — kept out of the repo tree entirely, no `.gitignore` changes needed.
- If two tasks in the same batch happen to touch overlapping files, the picker doesn't know or care (by design — see the project's earlier discussion). The second one to merge will conflict and is handled via the merge-conflict path above: preserved branch, loop halts, nothing is silently lost or overwritten.
- Never uses `git push`. All work stays local until the user pushes.
- Sub-agents never see each other and never coordinate directly — all coordination is the orchestrator serially processing claim → dispatch → merge for each batch.
