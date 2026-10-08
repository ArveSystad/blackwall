import { AsyncEntry } from "@napi-rs/keyring";
import { SECRET_SERVICE, SecretStoreError, type SecretStore } from "./secret-store.js";

/**
 * Secret store backed by the OS keychain: Windows Credential Manager, macOS
 * Keychain, or libsecret on Linux (best effort; needs a running secret service).
 * Each secret is stored under `service` with the account as username.
 *
 * Underlying errors are kept only as `cause` and wrapped in a `SecretStoreError`
 * whose message names the account, never the secret.
 */
export function createKeyringSecretStore(service = SECRET_SERVICE): SecretStore {
  const entry = (account: string) => new AsyncEntry(service, account);

  async function attempt<T>(
    operation: SecretStoreError["operation"],
    account: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw new SecretStoreError(operation, account, { cause: error });
    }
  }

  return {
    // Typed as `string | undefined`, but resolves `null` when there is no credential.
    get: (account) =>
      attempt("get", account, async () => (await entry(account).getPassword()) ?? undefined),
    set: (account, secret) => attempt("set", account, () => entry(account).setPassword(secret)),
    delete: (account) => attempt("delete", account, () => entry(account).deleteCredential()),
  };
}
