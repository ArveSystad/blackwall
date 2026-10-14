import {
  AgentNotFoundError,
  ChatActionNotFoundError,
  ChatMessageNotFoundError,
  ConnectionNotFoundError,
  DataArchiveTooNewError,
  DataImportBusyError,
  DatabaseBusyError,
  DeliveryError,
  FindingNotFoundError,
  GrillQuestionNotFoundError,
  InvalidAgentError,
  InvalidConnectionError,
  InvalidDataArchiveError,
  InvalidGateResponseError,
  InvalidRepoError,
  InvalidSettingsError,
  MissingCredentialError,
  RepoInUseError,
  RepoNotFoundError,
  RepoPushError,
  SecretStoreError,
  StaleRepoError,
  TaskNotFoundError,
  TaskStateError,
} from "@blackwall/core";
import {
  MISSING_CREDENTIAL_STATUS,
  STALE_REPO_STATUS,
  type MissingCredential,
  type StaleRepo,
} from "@blackwall/shared";
import type { Context } from "hono";

/** Maps domain errors to responses. Only messages known to be secret-free are returned. */
export function errorResponse(error: unknown, c: Context) {
  if (error instanceof MissingCredentialError) {
    return c.json<MissingCredential>(
      {
        error: "MissingCredential",
        kind: error.kind,
        host: error.host,
        connectionId: error.connectionId,
        message: error.message,
      },
      MISSING_CREDENTIAL_STATUS,
    );
  }
  if (error instanceof StaleRepoError) {
    return c.json<StaleRepo>(
      {
        error: "StaleRepo",
        repoId: error.repo.id,
        name: error.repo.name,
        path: error.repo.path,
        removed: error.removed,
        message: error.message,
      },
      STALE_REPO_STATUS,
    );
  }
  if (
    error instanceof ConnectionNotFoundError ||
    error instanceof RepoNotFoundError ||
    error instanceof AgentNotFoundError ||
    error instanceof TaskNotFoundError ||
    error instanceof GrillQuestionNotFoundError ||
    error instanceof FindingNotFoundError ||
    error instanceof ChatActionNotFoundError ||
    error instanceof ChatMessageNotFoundError
  ) {
    return c.json({ error: error.message }, 404);
  }
  if (
    error instanceof InvalidConnectionError ||
    error instanceof InvalidRepoError ||
    error instanceof InvalidAgentError ||
    error instanceof InvalidSettingsError ||
    error instanceof InvalidGateResponseError ||
    error instanceof InvalidDataArchiveError ||
    error instanceof DataArchiveTooNewError
  ) {
    return c.json({ error: error.message }, 400);
  }
  if (
    error instanceof RepoInUseError ||
    error instanceof TaskStateError ||
    error instanceof DataImportBusyError ||
    error instanceof DatabaseBusyError
  ) {
    return c.json({ error: error.message }, 409);
  }
  if (error instanceof DeliveryError || error instanceof RepoPushError) {
    // Git's or the host's own message; GitHub and Jira errors never carry the token.
    return c.json({ error: error.message }, 502);
  }
  if (error instanceof SecretStoreError) {
    // The message names the connection id only; the cause is not logged.
    console.error(error.message);
    return c.json({ error: "OS keychain unavailable" }, 503);
  }
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error");
  return c.json({ error: "internal error" }, 500);
}
