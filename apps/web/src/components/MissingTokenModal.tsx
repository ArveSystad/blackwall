import type { MissingCredential } from "@blackwall/shared";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { saveCredential } from "../api";
import { missingTokenCopy, type CredentialAction } from "../missing-token";
import { EyeIcon, EyeOffIcon, KeyIcon } from "./icons";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";

export interface MissingTokenModalProps {
  missing: MissingCredential;
  action: CredentialAction;
  onSaved: () => void;
  onCancel: () => void;
}

const fieldLabel = "text-meta font-medium text-foreground-strong";

/**
 * Asks for the token an action is missing, stores it (creating the connection
 * when the host has none), then lets the caller retry. The token is write-only:
 * it is never shown again once saved.
 */
export function MissingTokenModal({ missing, action, onSaved, onCancel }: MissingTokenModalProps) {
  const copy = missingTokenCopy(missing);
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [reveal, setReveal] = useState(false);
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
      setError(cause instanceof Error ? cause.message : "Could not save the token");
      setSaving(false);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
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
              <span className="inline-flex size-8 flex-none items-center justify-center rounded-lg border border-magenta/40 bg-needs-wash text-magenta">
                <KeyIcon size="lg" />
              </span>
              <DialogTitle className="m-0 text-heading font-semibold text-foreground-strong">
                {copy.title}
              </DialogTitle>
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
            <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-y-2 rounded-lg border border-border bg-card px-3 py-2.5 text-[12.5px]">
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
                    <span className="mono inline-flex h-[18px] items-center rounded-xs bg-muted px-[5px] text-label text-foreground-strong">
                      {copy.scope}
                    </span>
                    <span className="text-faint">required</span>
                  </dd>
                </>
              )}
            </dl>

            {copy.needsEmail && (
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>Account email</span>
                <Input
                  type="email"
                  autoComplete="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
            )}

            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>{copy.tokenLabel}</span>
              <span className="relative block">
                <Input
                  className="mono pr-9"
                  type={reveal ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  required
                  autoFocus={!copy.needsEmail}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  className="absolute top-[3px] right-[3px]"
                  aria-label={reveal ? "Hide token" : "Show token"}
                  aria-pressed={reveal}
                  onClick={() => setReveal((on) => !on)}
                >
                  {reveal ? <EyeOffIcon /> : <EyeIcon />}
                </Button>
              </span>
            </label>

            <div className="flex flex-col gap-1 text-meta text-muted-foreground">
              <a href={copy.createLink.href} target="_blank" rel="noreferrer">
                {copy.createLink.text}
              </a>
              <span>
                Stored on this machine only. It is never shown again; replace it from Settings ›
                Connections.
              </span>
            </div>

            {error && (
              <p className="m-0 text-meta text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border bg-card px-5 py-3">
            <Button variant="ghost" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={saving || !token.trim()}>
              {saving ? "Saving…" : "Save and continue"}
              <Kbd onFill aria-hidden="true">
                ↵
              </Kbd>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
