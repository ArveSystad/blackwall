# Source

A vendored copy of the OWASP Secure Agent Playbook. Code review copies this folder into each task's
`.blackwall/playbooks/owasp-secure-agent-playbook/` for the Security reviewer
(`packages/core/src/pipeline/playbook.ts`). Do not edit the upstream files here.

- Upstream: https://github.com/OWASP/secure-agent-playbook
- Commit: `65d4efd2cd0b081d52101e9708792b944e4ddebb` (release 0.2.11, 2026-10-15)
- Retrieved: 2026-10-16, from `https://codeload.github.com/OWASP/secure-agent-playbook/tar.gz/<commit>`
- License: CC BY 4.0 (`LICENSE.md`). Some bundled data carries its own terms, listed in
  `THIRD_PARTY_NOTICES.md` (for example the ASVS data under CC BY-SA 4.0).

## Included

Every Markdown file in the upstream repository, unchanged and in the upstream folder structure.

## Left out

- `scripts/`: Python and shell tooling for building the data and packaging skills. Reviewers are read-only
  and cannot run it.
- `examples/mobile-*-fixture/` source files (`.kt`, `.swift`, `.dart`, `.plist`, `.xml`, `.yaml`):
  deliberately vulnerable fixtures. Their Markdown in `examples/` is kept.
- `.claude-plugin/` and `plugins/*/.claude-plugin/` JSON manifests: Claude Code plugin registration,
  which Blackwall does not use.
- `.github/`: workflows, CODEOWNERS and issue templates.
- `.claude/skills/multi-agentic-threat-model/SKILL.md`: the same skill as
  `plugins/ai-security-skills/skills/multi-agentic-threat-model/SKILL.md`, placed for Claude Code's
  project skill discovery, which would otherwise pick it up.
- `.gitignore` and `CLAUDE.md`: instructions for working on the upstream repository, which Claude Code
  would otherwise load as project instructions.

## Updating

1. Download the tarball at the new commit into a new, empty folder and extract it.
2. Replace this folder with the upstream Markdown files, leaving out the same files as above.
3. Update the commit, dates and anything new under "Left out" in this file.
4. If the index or the code review play moved, update `SECURE_PLAYBOOK_ENTRY` or
   `SECURE_PLAYBOOK_CODE_REVIEW` in `packages/core/src/pipeline/playbook.ts`.
5. Review the diff: this text goes into reviewer prompts.
