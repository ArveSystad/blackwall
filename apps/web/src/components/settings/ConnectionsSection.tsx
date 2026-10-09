import type { ConnectionKind, ConnectionView, MissingCredential } from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import {
  MissingCredentialError,
  createConnection,
  deleteConnection,
  forgetToken,
  testConnection,
} from "../../api";
import { useWithCredential } from "../../credentials";
import { missingTokenCopy } from "../../missing-token";
import { connectionsQuery, queryKeys } from "../../query";
import { ConfirmDialog } from "../ConfirmDialog";
import { PlusIcon } from "../icons";
import { MissingTokenModal } from "../MissingTokenModal";
import { Segmented } from "../Segmented";
import { StatusBadge } from "../StatusBadge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { ErrorText, Field } from "../ui/field";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { SecretInput } from "../ui/secret-input";
import {
  connectionDraftHost,
  connectionDraftToInput,
  emptyConnectionDraft,
  errorMessage,
  type ConnectionDraft,
} from "../../settings-forms";
import { Empty, SectionHeader } from "./parts";

type TestState =
  | { state: "idle" }
  | { state: "pending" }
  | { state: "ok"; detail: string }
  | { state: "error"; detail: string };

/** The connection's host, as the missing-token modal names it. */
function hostOf(connection: ConnectionView): string {
  try {
    return new URL(connection.baseUrl).host;
  } catch {
    return connection.name;
  }
}

function ConnectionRow({ connection }: { connection: ConnectionView }) {
  const queryClient = useQueryClient();
  const withCredential = useWithCredential();
  const [test, setTest] = useState<TestState>({ state: "idle" });
  const [dialog, setDialog] = useState<"token" | "forget" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.connections });

  async function run() {
    setTest({ state: "pending" });
    try {
      const result = await withCredential(
        { label: "Test connection", target: connection.name },
        () => testConnection(connection.id),
      );
      setTest(
        result.ok
          ? { state: "ok", detail: `Signed in as ${result.account}` }
          : { state: "error", detail: result.message },
      );
    } catch (cause) {
      setTest({
        state: "error",
        detail:
          cause instanceof MissingCredentialError
            ? "Cancelled: no token saved"
            : errorMessage(cause),
      });
    }
  }

  async function forget() {
    setError(null);
    await forgetToken(connection.id);
    setTest({ state: "idle" });
    await refresh();
  }

  const missing: MissingCredential = {
    error: "MissingCredential",
    kind: connection.kind,
    host: hostOf(connection),
    connectionId: connection.id,
    message: "",
  };

  return (
    <li className="flex min-h-10 flex-wrap items-center gap-3 border-b border-border px-4 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium text-foreground-strong">{connection.name}</span>
        <span className="mono truncate text-muted-foreground">{connection.baseUrl}</span>
        {test.state === "ok" && <span className="text-meta text-done">{test.detail}</span>}
        {test.state === "error" && <ErrorText>{test.detail}</ErrorText>}
        {error && <ErrorText>{error}</ErrorText>}
      </div>
      <span className="text-meta text-muted-foreground">
        {connection.kind === "jira" ? "Jira Cloud" : "GitHub"}
      </span>
      {connection.hasToken ? (
        <StatusBadge status="done" label="Configured" />
      ) : (
        <StatusBadge status="needs-you" label="Missing" />
      )}
      <Button size="sm" disabled={test.state === "pending"} onClick={() => void run()}>
        {test.state === "pending" ? "Testing…" : "Test"}
      </Button>
      <Button size="sm" onClick={() => setDialog("token")}>
        {connection.hasToken ? "Replace token" : "Set token"}
      </Button>
      {connection.hasToken && (
        <Button size="sm" variant="ghost" onClick={() => setDialog("forget")}>
          Forget token
        </Button>
      )}
      <Button size="sm" variant="destructive-ghost" onClick={() => setDialog("remove")}>
        Remove
      </Button>

      {dialog === "token" && (
        <MissingTokenModal
          missing={missing}
          action={{
            label: connection.hasToken ? "Replace token" : "Set token",
            target: connection.name,
          }}
          onSaved={() => {
            setDialog(null);
            setTest({ state: "idle" });
            void refresh();
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "forget" && (
        <ConfirmDialog
          title={`Forget the token for ${connection.name}?`}
          confirmLabel="Forget token"
          onConfirm={forget}
          onClose={() => setDialog(null)}
        >
          The token is removed from the OS keychain. A{" "}
          <span className="mono">BLACKWALL_TOKEN_*</span> environment override, if set, still
          applies.
        </ConfirmDialog>
      )}
      {dialog === "remove" && (
        <ConfirmDialog
          title={`Remove ${connection.name}?`}
          confirmLabel="Remove connection"
          onConfirm={async () => {
            await deleteConnection(connection.id);
            await Promise.all([
              refresh(),
              queryClient.invalidateQueries({ queryKey: queryKeys.repos }),
            ]);
          }}
          onClose={() => setDialog(null)}
        >
          The connection and its keychain token are deleted. Tasks against{" "}
          <span className="mono">{hostOf(connection)}</span> will ask for a token again.
        </ConfirmDialog>
      )}
    </li>
  );
}

function AddConnectionDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ConnectionDraft>(() => emptyConnectionDraft());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const jira = draft.kind === "jira";
  // The Jira link is fixed; GitHub's is built from the host, so it waits for a valid one.
  const host = connectionDraftHost(draft.host);
  const copy =
    jira || host !== null
      ? missingTokenCopy({
          error: "MissingCredential",
          kind: draft.kind,
          host: host ?? "",
          connectionId: null,
          message: "",
        })
      : null;

  const update = (patch: Partial<ConnectionDraft>) => setDraft((d) => ({ ...d, ...patch }));

  function setKind(kind: ConnectionKind) {
    update({ kind, host: emptyConnectionDraft(kind).host });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !draft.host.trim()) return;
    setPending(true);
    setError(null);
    try {
      const input = connectionDraftToInput(draft);
      const connection = await createConnection(input);
      // Repos show the connection they use.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.connections }),
        queryClient.invalidateQueries({ queryKey: queryKeys.repos }),
      ]);
      onDone(`Added ${connection.name}.${input.token ? "" : " Set a token to use it."}`);
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)}>
          <div className="flex flex-col gap-3.5 px-5 pt-[18px] pb-[18px]">
            <DialogTitle>Add connection</DialogTitle>
            <DialogDescription className="m-0 text-pretty">
              Connect a GitHub host or a Jira Cloud site. The token can be set now or later.
            </DialogDescription>
            <Segmented
              label="Connection type"
              value={draft.kind}
              onChange={setKind}
              options={[
                { value: "github", label: "GitHub" },
                { value: "jira", label: "Jira Cloud" },
              ]}
            />
            <Field
              label="Host or URL"
              hint="GitHub.com, a GitHub Enterprise host, or a Jira Cloud site."
            >
              <Input
                className="mono"
                autoFocus
                required
                spellCheck={false}
                placeholder={jira ? "acme.atlassian.net" : "github.com"}
                value={draft.host}
                onChange={(event) => update({ host: event.target.value })}
              />
            </Field>
            <Field label="Name">
              <Input
                placeholder="Defaults to the host"
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>
            {jira && (
              <Field label="Account email">
                <Input
                  type="email"
                  autoComplete="email"
                  required
                  value={draft.email}
                  onChange={(event) => update({ email: event.target.value })}
                />
              </Field>
            )}
            <Field
              label={
                <>
                  {jira ? "API token" : "Personal access token"}{" "}
                  <span className="ml-1 font-normal text-faint">Optional</span>
                </>
              }
            >
              <SecretInput
                value={draft.token}
                onChange={(event) => update({ token: event.target.value })}
              />
            </Field>
            <div className="flex flex-col gap-1 text-meta text-muted-foreground">
              {copy && (
                <a href={copy.createLink.href} target="_blank" rel="noreferrer">
                  {copy.createLink.text}
                </a>
              )}
              {copy?.scope && (
                <span>
                  Needs the <span className="mono">{copy.scope}</span> scope.
                </span>
              )}
              <span>Stored on this machine only. It is never shown again.</span>
            </div>
            {error && <ErrorText>{error}</ErrorText>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={pending || !draft.host.trim()}>
              {pending ? "Adding…" : "Add connection"}
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

/** Connections with their token status only; tokens are never sent to the browser. */
export function ConnectionsSection() {
  const connections = useQuery(connectionsQuery);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto">
      <SectionHeader title="Connections">
        <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
          <PlusIcon />
          Add
        </Button>
      </SectionHeader>
      {message && (
        <p
          className="m-0 border-b border-border px-4 py-2 text-meta text-muted-foreground"
          role="status"
        >
          {message}
        </p>
      )}
      {connections.isPending ? (
        <Empty>Loading connections…</Empty>
      ) : connections.isError ? (
        <Empty>{connections.error.message}</Empty>
      ) : connections.data.length === 0 ? (
        <Empty>
          No connections yet. Add one, or start a task against a new host and you&apos;ll be asked
          for a token.
        </Empty>
      ) : (
        <ul className="m-0 list-none p-0">
          {connections.data.map((connection) => (
            <ConnectionRow key={connection.id} connection={connection} />
          ))}
        </ul>
      )}
      {adding && (
        <AddConnectionDialog
          onClose={() => setAdding(false)}
          onDone={(text) => {
            setAdding(false);
            setMessage(text);
          }}
        />
      )}
    </div>
  );
}
