---
id: task-008
title: Web app shell, theming and two-pane layout
status: backlog
depends_on: [task-002, task-004]
---

## Goal
The frame every screen lives in.

## Scope
- React + Vite, TanStack Router + Query, Tailwind + shadcn/ui.
- Design tokens for dark (cyberpunk blue-purple, neon glow accents, muted text, conventional diff colors) and light themes, following `prefers-color-scheme`. Apply Claude Design output when available.
- Two-pane layout: task list on the left, main view on the right; Settings route.
- WebSocket client with reconnect, wired into Query cache invalidation.
- Tab title shows the needs-you count: `(N) blackwall`.

## Acceptance criteria
- The theme follows the OS setting; both themes render all primitives legibly.
- Live server events update the UI without a reload.

## Refs
grill-result.md §8, claude-design.md
