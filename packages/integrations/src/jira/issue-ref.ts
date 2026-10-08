import { JIRA_KEY_PATTERN } from "@blackwall/shared";

/** A Jira issue as the user typed it: the key, plus the site when given as a URL. */
export interface JiraIssueRef {
  key: string;
  /** Site origin (e.g. `https://acme.atlassian.net`) when parsed from a URL. */
  baseUrl?: string;
}

const KEY_IN_TEXT = /[A-Z][A-Z0-9_]*-\d+/;

function asKey(value: string | null | undefined): string | undefined {
  const key = value?.trim().toUpperCase();
  return key && JIRA_KEY_PATTERN.test(key) ? key : undefined;
}

/**
 * Parses a Jira key (`ABC-123`, any case) or an issue URL: `/browse/ABC-123`,
 * a board or search link with `?selectedIssue=ABC-123`, or a REST
 * `/rest/api/<v>/issue/ABC-123` link. Returns undefined when neither fits.
 */
export function parseJiraIssueRef(input: string): JiraIssueRef | undefined {
  const value = input.trim();
  const bare = asKey(value);
  if (bare) return { key: bare };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;

  const fromQuery = asKey(url.searchParams.get("selectedIssue"));
  const fromPath = /\/(?:browse|issue)\/([^/?#]+)/i.exec(url.pathname)?.[1];
  const key = fromQuery ?? asKey(fromPath && decodeURIComponent(fromPath));
  if (!key) {
    // Last resort: a key anywhere in the path (e.g. `/jira/software/…/ABC-123`).
    const loose = KEY_IN_TEXT.exec(url.pathname.toUpperCase())?.[0];
    return loose ? { key: loose, baseUrl: url.origin } : undefined;
  }
  return { key, baseUrl: url.origin };
}
