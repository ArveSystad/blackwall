import type { MissingCredential } from "@blackwall/shared";

/** The action that hit the missing credential, as the modal names it. */
export interface CredentialAction {
  /** What the user started, e.g. "Review PR". */
  label: string;
  /** What it ran against, e.g. `platform/gateway#212` (shown in mono). */
  target?: string;
}

export interface MissingTokenCopy {
  title: string;
  /** "GitHub.com", "GitHub Enterprise Server" or "Jira Cloud". */
  hostType: string;
  /** Rest of the sentence after "Starting <action> on <target> ". */
  needs: string;
  tokenLabel: string;
  /** Scope the token needs, if the host has scopes. */
  scope?: string;
  /** Asks for the Jira account email: only when a new Jira connection is created. */
  needsEmail: boolean;
  createLink: { href: string; text: string };
}

const ATLASSIAN_TOKENS_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

/** Copy and links for the missing-token modal. */
export function missingTokenCopy(missing: MissingCredential): MissingTokenCopy {
  const { host, kind, connectionId } = missing;
  if (kind === "jira") {
    return {
      title: `Token needed for ${host}`,
      hostType: "Jira Cloud",
      needs: "needs an API token for this Jira Cloud site.",
      tokenLabel: "API token",
      needsEmail: connectionId === null,
      createLink: { href: ATLASSIAN_TOKENS_URL, text: "Create one at id.atlassian.com ↗" },
    };
  }
  const dotCom = host === "github.com";
  const query = new URLSearchParams({ scopes: "repo", description: "blackwall" });
  return {
    title: `Token needed for ${host}`,
    hostType: dotCom ? "GitHub.com" : "GitHub Enterprise Server",
    needs: `needs a personal access token for this ${dotCom ? "GitHub" : "GitHub Enterprise"} host.`,
    tokenLabel: "Personal access token",
    scope: "repo",
    needsEmail: false,
    createLink: {
      href: `https://${host}/settings/tokens/new?${query.toString()}`,
      text: `Create one on ${host} with repo scope ↗`,
    },
  };
}
