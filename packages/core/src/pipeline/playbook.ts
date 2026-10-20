import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRATCH_DIR } from "@blackwall/shared";
import { ensureScratchDir } from "./artifacts.js";

/** The OWASP Secure Agent Playbook as vendored with Blackwall (see its `SOURCE.md`). */
export const SECURE_PLAYBOOK_SOURCE = fileURLToPath(
  new URL("../../playbooks/owasp-secure-agent-playbook", import.meta.url),
);

/** Where code review puts the playbook, relative to the worktree. */
export const SECURE_PLAYBOOK_DIR = `${SCRATCH_DIR}/playbooks/owasp-secure-agent-playbook`;

/** The playbook's index, relative to {@link SECURE_PLAYBOOK_DIR}. */
export const SECURE_PLAYBOOK_ENTRY = "README.md";

/** The playbook's code review procedure, relative to {@link SECURE_PLAYBOOK_DIR}. */
export const SECURE_PLAYBOOK_CODE_REVIEW =
  "plugins/code-security-skills/plays/code-review-security.md";

/**
 * Copies the playbook (from `source`, the vendored one by default) into the
 * worktree's git-ignored scratch folder, where read-only reviewers can read it.
 * Any earlier copy is replaced, so an edited or stale copy never reaches the
 * next review.
 */
export async function installSecurePlaybook(
  worktree: string,
  source = SECURE_PLAYBOOK_SOURCE,
): Promise<void> {
  await ensureScratchDir(worktree);
  const target = join(worktree, SECURE_PLAYBOOK_DIR);
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
}
