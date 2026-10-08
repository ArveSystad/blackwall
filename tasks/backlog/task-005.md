---
id: task-005
title: Secret store (OS keychain + env overrides)
status: backlog
depends_on: [task-001]
---

## Goal
PATs never touch SQLite or the browser.

## Scope
- `SecretStore` interface in core, implemented with `@napi-rs/keyring` (service `blackwall`, account = connection id).
- Env overrides (e.g. `BLACKWALL_TOKEN_<CONNECTION>`) take precedence.
- API exposes only `hasToken: boolean`.

## Acceptance criteria
- Set/get/delete works with Windows Credential Manager and macOS Keychain (libsecret best-effort).
- No API response or log line ever contains a token.

## Refs
grill-result.md §7
