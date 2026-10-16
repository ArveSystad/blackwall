import type { MissingCredential } from "@blackwall/shared";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { saveCredential } from "../api";
import { isModKey } from "../keyboard";
import { missingTokenCopy, type CredentialAction } from "../missing-token";
import { errorMessage } from "../settings-forms";
import { KeyIcon } from "./icons";
import { Button } from "./ui/button";
import { Tag } from "./ui/chip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { ErrorText, Field } from "./ui/field";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";
import { SecretInput } from "./ui/secret-input";

export interface MissingTokenModalProps {
  missing: MissingCredential;
  action: CredentialAction;
  onSaved: () => void;
  onCancel: () => void;
}

/**
 * Asks for the token an action is missing, stores it (creating the connection
 * when the host has none), then lets the caller retry. The token is write-only:
 * it is never shown again once saved.
 */
export function MissingTokenModal({ missing, action, onSaved, onCancel }: MissingTokenModalProps) {
  const copy = missingTokenCopy(missing);
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (saving || !token.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await saveCredential(missing, {
        token: token.trim(),
        ...(copy.needsEmail ? { email: email.trim() } : {}),
      });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && isModKey(event.nativeEvent)) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    // Esc and the overlay close through state so the pending action is told it was cancelled.
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} onKeyDown={onKeyDown}>
          <div className="flex flex-col gap-2.5 px-5 pt-[18px] pb-1">
            <div className="flex items-center gap-2.5">
              <span className="bw-chamfer inline-flex size-8 flex-none items-center justify-center bg-needs-wash text-magenta [--bw-chamfer-line:color-mix(in_oklab,var(--magenta)_40%,transparent)]">
                <KeyIcon size="lg" />
              </span>
              <DialogTitle>{copy.title}</DialogTitle>
            </div>
            <DialogDescription className="m-0 text-pretty">
              Starting <span className="text-foreground-strong">{action.label}</span>
              {action.target && (
                <>
                  {" on "}
                  <span className="mono text-foreground-strong">{action.target}</span>
                </>
              )}{" "}
              {copy.needs}
              {missing.connectionId === null &&
                " There is no connection for it yet; saving adds one."}
            </DialogDescription>
          </div>

          <div className="flex flex-col gap-3.5 px-5 pt-3.5 pb-[18px]">
            <dl className="bw-chamfer m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-y-2 bg-card px-3 py-2.5 text-[12.5px] [--bw-chamfer-line:var(--border)]">
              <dt className="text-muted-foreground">Host</dt>
              <dd className="mono m-0 min-w-0 [overflow-wrap:anywhere] text-foreground-strong">
                {missing.host}
              </dd>
              <dt className="text-muted-foreground">Type</dt>
              <dd className="m-0">{copy.hostType}</dd>
              {copy.scope && (
                <>
                  <dt className="text-muted-foreground">Scopes</dt>
                  <dd className="m-0 flex items-center gap-1">
                    <Tag className="text-foreground-strong">{copy.scope}</Tag>
                    <span className="text-faint">required</span>
                  </dd>
                </>
              )}
            </dl>

            {copy.needsEmail && (
              <Field label="Account email">
                <Input
                  type="email"
                  autoComplete="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>
            )}

            <Field label={copy.tokenLabel}>
              <SecretInput
                required
                autoFocus={!copy.needsEmail}
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </Field>

            <div className="flex flex-col gap-1 text-meta text-muted-foreground">
              <a href={copy.createLink.href} target="_blank" rel="noreferrer">
                {copy.createLink.text}
              </a>
              <span>
                Stored on this machine only. It is never shown again; replace it from Settings ›
                Connections.
              </span>
            </div>

            {error && <ErrorText>{error}</ErrorText>}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={saving || !token.trim()}>
              {saving ? "Saving…" : "Save and continue"}
              <Kbd onFill aria-hidden="true">
                ↵
              </Kbd>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
