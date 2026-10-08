import type { MissingCredential } from "@blackwall/shared";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { saveCredential } from "../api";
import { missingTokenCopy, type CredentialAction } from "../missing-token";

export interface MissingTokenModalProps {
  missing: MissingCredential;
  action: CredentialAction;
  onSaved: () => void;
  onCancel: () => void;
}

function KeyIcon() {
  return (
    <svg className="i i-md" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="5.5" cy="10.5" r="3" />
      <path d="m7.6 8.4 5.9-5.9M11.5 4.5l1.5 1.5M10 6l1.2 1.2" />
    </svg>
  );
}

function EyeIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg className="i" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
      {crossed && <path d="m2.5 2.5 11 11" />}
    </svg>
  );
}

/**
 * Asks for the token an action is missing, stores it (creating the connection
 * when the host has none), then lets the caller retry. The token is write-only:
 * it is never shown again once saved.
 */
export function MissingTokenModal({ missing, action, onSaved, onCancel }: MissingTokenModalProps) {
  const copy = missingTokenCopy(missing);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => node?.close();
  }, []);

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
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Esc: close through state so the pending action is told it was cancelled.
        event.preventDefault();
        onCancel();
      }}
    >
      <form onSubmit={(event) => void submit(event)} onKeyDown={onKeyDown}>
        <div className="modal-head">
          <div className="modal-title-row">
            <span className="needs-icon">
              <KeyIcon />
            </span>
            <h2 id={titleId} className="modal-title">
              {copy.title}
            </h2>
          </div>
          <p>
            Starting <span className="strong">{action.label}</span>
            {action.target && (
              <>
                {" on "}
                <span className="mono strong">{action.target}</span>
              </>
            )}{" "}
            {copy.needs}
            {missing.connectionId === null &&
              " There is no connection for it yet; saving adds one."}
          </p>
        </div>

        <div className="modal-body">
          <dl className="card facts">
            <dt className="muted">Host</dt>
            <dd className="mono strong">{missing.host}</dd>
            <dt className="muted">Type</dt>
            <dd>{copy.hostType}</dd>
            {copy.scope && (
              <>
                <dt className="muted">Scopes</dt>
                <dd className="scopes">
                  <span className="tag strong">{copy.scope}</span>
                  <span className="faint">required</span>
                </dd>
              </>
            )}
          </dl>

          {copy.needsEmail && (
            <label className="field">
              <span className="field-label">Account email</span>
              <input
                className="input"
                type="email"
                autoComplete="email"
                required
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
          )}

          <label className="field">
            <span className="field-label">{copy.tokenLabel}</span>
            <span className="secret-field">
              <input
                className="input mono"
                type={reveal ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                required
                autoFocus={!copy.needsEmail}
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
              <button
                className="btn btn-ghost btn-icon btn-sm"
                type="button"
                aria-label={reveal ? "Hide token" : "Show token"}
                aria-pressed={reveal}
                onClick={() => setReveal((on) => !on)}
              >
                <EyeIcon crossed={reveal} />
              </button>
            </span>
          </label>

          <div className="hint">
            <a href={copy.createLink.href} target="_blank" rel="noreferrer">
              {copy.createLink.text}
            </a>
            <span>
              Stored on this machine only. It is never shown again; replace it from Settings ›
              Connections.
            </span>
          </div>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" disabled={saving || !token.trim()}>
            {saving ? "Saving…" : "Save and continue"}
            <span className="kbd" aria-hidden="true">
              ↵
            </span>
          </button>
        </div>
      </form>
    </dialog>
  );
}
