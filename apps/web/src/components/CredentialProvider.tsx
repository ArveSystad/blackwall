import type { MissingCredential } from "@blackwall/shared";
import { useCallback, useState, type ReactNode } from "react";
import { runWithCredential } from "../api";
import { CredentialContext, type WithCredential } from "../credentials";
import type { CredentialAction } from "../missing-token";
import { MissingTokenModal } from "./MissingTokenModal";

interface Prompt {
  id: string;
  missing: MissingCredential;
  action: CredentialAction;
  settle: (saved: boolean) => void;
}

/** Provides `useWithCredential` and renders the missing-token modal when an action needs it. */
export function CredentialProvider({ children }: { children: ReactNode }) {
  // Queued so that concurrent actions each get their own prompt, one at a time.
  const [prompts, setPrompts] = useState<Prompt[]>([]);

  const withCredential = useCallback<WithCredential>(
    (action, run) =>
      runWithCredential(
        run,
        (missing) =>
          new Promise<boolean>((resolve) => {
            const prompt: Prompt = {
              id: crypto.randomUUID(),
              missing,
              action,
              settle: (saved) => {
                setPrompts((queue) => queue.filter((p) => p !== prompt));
                resolve(saved);
              },
            };
            setPrompts((queue) => [...queue, prompt]);
          }),
      ),
    [],
  );

  const current = prompts[0];
  return (
    <CredentialContext.Provider value={withCredential}>
      {children}
      {current && (
        <MissingTokenModal
          // A fresh form per prompt.
          key={current.id}
          missing={current.missing}
          action={current.action}
          onSaved={() => current.settle(true)}
          onCancel={() => current.settle(false)}
        />
      )}
    </CredentialContext.Provider>
  );
}
