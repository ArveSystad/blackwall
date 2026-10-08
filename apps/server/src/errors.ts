import {
  ConnectionNotFoundError,
  InvalidConnectionError,
  MissingCredentialError,
  SecretStoreError,
} from "@blackwall/core";
import { MISSING_CREDENTIAL_STATUS, type MissingCredential } from "@blackwall/shared";
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
  if (error instanceof ConnectionNotFoundError) return c.json({ error: error.message }, 404);
  if (error instanceof InvalidConnectionError) return c.json({ error: error.message }, 400);
  if (error instanceof SecretStoreError) {
    // The message names the connection id only; the cause is not logged.
    console.error(error.message);
    return c.json({ error: "OS keychain unavailable" }, 503);
  }
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error");
  return c.json({ error: "internal error" }, 500);
}
