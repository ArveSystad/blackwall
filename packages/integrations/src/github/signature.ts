import { APP_NAME } from "@blackwall/shared";

/** Footer that marks a PR comment or review as posted by the harness. */
export const COMMENT_SIGNATURE = `_Posted from ${APP_NAME}_`;

/**
 * Footer that marks a PR review comment as written by the user in the
 * harness. It does not end with {@link COMMENT_SIGNATURE}, so such comments
 * are read back as reviewer feedback.
 */
export const HUMAN_COMMENT_SIGNATURE = `_Posted by an actual human being from ${APP_NAME}_`;

function sign(body: string, signature: string): string {
  const trimmed = body.trimEnd();
  if (trimmed.endsWith(signature)) return trimmed;
  return trimmed ? `${trimmed}\n\n---\n${signature}` : `---\n${signature}`;
}

/** Appends {@link COMMENT_SIGNATURE} below a rule; a body that already ends with it is left as is. */
export function signComment(body: string): string {
  return sign(body, COMMENT_SIGNATURE);
}

/** Appends {@link HUMAN_COMMENT_SIGNATURE} below a rule; a body that already ends with it is left as is. */
export function signHumanComment(body: string): string {
  return sign(body, HUMAN_COMMENT_SIGNATURE);
}
