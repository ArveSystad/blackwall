---
name: commit
description: 'Commit all changes made during task work with a well-structured conventional commit message. Groups changes into logical commits when the diff spans multiple concerns. Use after completing or mid-way through a task.'
argument-hint: 'Optional: short hint about what changed (e.g. "fix null date handling")'
---

# Commit Task Work

## Communication style

Follow the `caveman` skill for narration and status updates while running this — terse, no filler. The commit message itself and the diff stay normal prose (caveman's own boundaries).

## When to Use

- After finishing a task (or a logical chunk of task work) and the changes should be committed
- User says "commit", "commit the changes", "save progress", or similar
- Called naturally at the end of a `start-task` or `end-task` workflow

## Procedure

### 1. Survey the Changes

Run these in parallel:

```
git status
git diff HEAD
```

Read the full diff carefully. Note which files changed and what the changes actually do — not just file names, but the intent of each change.

### 2. Group into Logical Commits

Decide whether the changes form **one** logical unit or **multiple** independent concerns. Split only when there is a genuine semantic boundary — e.g. a backend fix and an unrelated frontend refactor. Avoid splitting a single coherent change just because it touches multiple files.

Common groupings:
- A bug fix and its test → one commit
- A new feature and its i18n strings → one commit
- An unrelated refactor touched in passing → separate commit
- Task housekeeping (moving task files, updating `done.md`) → separate commit if substantial, otherwise fold into the main commit

### 3. Write the Commit Message

Use **Conventional Commits** format:

```
<type>(<scope>): <short imperative summary>

<optional body — only if the why is non-obvious>
```

**Type** — pick the most accurate:
- `fix` — bug fix
- `feat` — new feature or behaviour
- `perf` — performance improvement
- `refactor` — restructuring without behaviour change
- `test` — adding or fixing tests
- `chore` — task/config housekeeping

**Scope** — the area of the codebase (optional but preferred):
- `frontend`, `backend`, `api`, `db`, `auth`, `events`, `invitations`, `discussion`, `admin`, or a specific component/file name

**Summary rules:**
- Imperative mood: "remove t from deps" not "removed" or "removes"
- ≤ 72 characters on the first line
- No trailing period
- Focus on *what* and *why*, not *how*

**Body** (include only when the reason is not obvious from the diff):
- Explain the problem that was fixed or the motivation for the change
- One blank line after the summary

### 4. Stage and Commit

For each logical group, stage only the files in that group and commit:

```bash
git add <file1> <file2> ...
git commit -m "$(cat <<'EOF'
<type>(<scope>): <summary>

<optional body>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

Always include the `Co-Authored-By` trailer.

### 5. Confirm

After all commits, run `git log --oneline -5` and show the result so the user can see what was committed.

## Examples

```
fix(frontend): remove t from useEffect deps in confirm pages

The translation function reference must not trigger re-confirmation
API calls. Locale changes should never re-fire magic-link or sign-up
confirmation effects.
```

```
perf(frontend): move DateTimePicker CSS injection to module level
```

```
refactor(backend): split MeEndpoints into focused endpoint files
```

## Notes

- Never use `git add -A` or `git add .` — stage files explicitly by name
- Never use `--no-verify`
- If there is nothing to commit (`git status` shows clean), say so and stop
- Task file moves (`tasks/in-progress/ → tasks/done/`) and `done.md` updates count as one chore commit if not already committed; fold them into the main commit if they are the only changes alongside it
