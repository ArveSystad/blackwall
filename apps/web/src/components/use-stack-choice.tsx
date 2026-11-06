import type { PullRequestStackLookup, TaskOrigin } from "@blackwall/shared";
import { useCallback, useState } from "react";
import { MissingCredentialError, lookupPullRequestStack } from "../api";
import { StackChoiceDialog } from "./StackChoiceDialog";

/** What to send as `stackSiblings`; undefined leaves it to the server; "cancel" adds nothing. */
export type StackChoice = boolean | undefined | "cancel";

/**
 * Asks whether a stacked PR origin should also queue Review PR items for the
 * rest of its stack. Render `dialog`; `askStack` resolves on the user's
 * choice and never throws for a cancel. Call it inside `withCredential`: a
 * missing token still throws so the token modal opens.
 */
export function useStackChoice() {
  const [asking, setAsking] = useState<{
    members: PullRequestStackLookup["prs"];
    current: number;
    resolve: (choice: StackChoice) => void;
  } | null>(null);

  const askStack = useCallback(async (origin: TaskOrigin): Promise<StackChoice> => {
    if (origin.kind !== "github-pr") return undefined;
    let members: PullRequestStackLookup["prs"];
    try {
      ({ prs: members } = await lookupPullRequestStack(origin.url));
    } catch (error) {
      // Other failures leave it to the server, which never blocks the item.
      if (error instanceof MissingCredentialError) throw error;
      return undefined;
    }
    if (members.length < 2) return undefined;
    return new Promise<StackChoice>((resolve) =>
      setAsking({ members, current: origin.number, resolve }),
    );
  }, []);

  const answer = (choice: StackChoice) => {
    asking?.resolve(choice);
    setAsking(null);
  };

  const dialog = asking && (
    <StackChoiceDialog
      members={asking.members}
      current={asking.current}
      onChoose={(all) => answer(all)}
      onClose={() => answer("cancel")}
    />
  );

  return { askStack, dialog };
}
