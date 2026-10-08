/** Keychain service name every blackwall secret is stored under. */
export const SECRET_SERVICE = "blackwall";

/**
 * Stores secrets by account (a connection id). Implementations must never put
 * a secret in an error message or log line.
 */
export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, secret: string): Promise<void>;
  /** Resolves `true` if a secret was removed, `false` if there was none. */
  delete(account: string): Promise<boolean>;
}

/** Raised when the OS credential store cannot be used. The message never contains a secret. */
export class SecretStoreError extends Error {
  constructor(
    readonly operation: "get" | "set" | "delete",
    readonly account: string,
    options?: ErrorOptions,
  ) {
    super(`Could not ${operation} secret for ${account} in the OS keychain`, options);
    this.name = "SecretStoreError";
  }
}

/** Process-local store for tests and headless runs without a keychain. */
export function createMemorySecretStore(): SecretStore {
  const secrets = new Map<string, string>();
  return {
    get: (account) => Promise.resolve(secrets.get(account)),
    set: (account, secret) => {
      secrets.set(account, secret);
      return Promise.resolve();
    },
    delete: (account) => Promise.resolve(secrets.delete(account)),
  };
}
