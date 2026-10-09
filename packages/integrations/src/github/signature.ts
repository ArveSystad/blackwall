import { APP_NAME } from "@blackwall/shared";

/** Footer that marks a PR comment or review as posted by the harness. */
export const COMMENT_SIGNATURE = `_Posted from ${APP_NAME}_`;

/** Appends {@link COMMENT_SIGNATURE} below a rule; a body that already ends with it is left as is. */
export function signComment(body: string): string {
  const trimmed = body.trimEnd();
  if (trimmed.endsWith(COMMENT_SIGNATURE)) return trimmed;
  return trimmed ? `${trimmed}\n\n---\n${COMMENT_SIGNATURE}` : `---\n${COMMENT_SIGNATURE}`;
}
