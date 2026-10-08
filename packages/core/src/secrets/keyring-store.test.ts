import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKeyringSecretStore } from "./keyring-store.js";

// Touches the real OS keychain (Windows Credential Manager, macOS Keychain,
// libsecret), so it is opt-in: BLACKWALL_TEST_KEYRING=1 pnpm test
describe.runIf(process.env.BLACKWALL_TEST_KEYRING === "1")("keyring secret store", () => {
  it("sets, gets and deletes a secret", async () => {
    const store = createKeyringSecretStore("blackwall-test");
    const account = `test-${randomUUID()}`;
    const secret = `secret-${randomUUID()}`;
    try {
      expect(await store.get(account)).toBeUndefined();
      await store.set(account, secret);
      expect(await store.get(account)).toBe(secret);
      expect(await store.delete(account)).toBe(true);
      expect(await store.get(account)).toBeUndefined();
      expect(await store.delete(account)).toBe(false);
    } finally {
      await store.delete(account).catch(() => undefined);
    }
  });
});
