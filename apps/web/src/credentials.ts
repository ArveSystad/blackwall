import { createContext, useContext } from "react";
import type { CredentialAction } from "./missing-token";

/**
 * Runs an API action; when it needs a missing connection or token, shows the
 * missing-token modal and retries after the token is saved. Rejects with
 * `MissingCredentialError` if the user cancels.
 */
export type WithCredential = <T>(action: CredentialAction, run: () => Promise<T>) => Promise<T>;

export const CredentialContext = createContext<WithCredential | null>(null);

export function useWithCredential(): WithCredential {
  const withCredential = useContext(CredentialContext);
  if (!withCredential) throw new Error("useWithCredential needs a CredentialProvider");
  return withCredential;
}
