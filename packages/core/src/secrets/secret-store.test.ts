import { describe, expect, it } from "vitest";
import { SecretStoreError, createMemorySecretStore } from "./secret-store.js";

describe("memory secret store", () => {
  it("sets, gets and deletes", async () => {
    const store = createMemorySecretStore();
    await store.set("c1", "s3cret");
    expect(await store.get("c1")).toBe("s3cret");
    expect(await store.delete("c1")).toBe(true);
    expect(await store.delete("c1")).toBe(false);
    expect(await store.get("c1")).toBeUndefined();
  });
});

describe("SecretStoreError", () => {
  it("names the account but not the secret", () => {
    const error = new SecretStoreError("set", "c1", { cause: new Error("boom") });
    expect(error.message).toBe("Could not set secret for c1 in the OS keychain");
  });
});
