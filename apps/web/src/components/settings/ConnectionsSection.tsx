import type { ConnectionView, MissingCredential } from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { MissingCredentialError, deleteConnection, forgetToken, testConnection } from "../../api";
import { useWithCredential } from "../../credentials";
import { connectionsQuery, queryKeys } from "../../query";
import { ConfirmDialog } from "../ConfirmDialog";
import { MissingTokenModal } from "../MissingTokenModal";
import { StatusBadge } from "../StatusBadge";
import { Button } from "../ui/button";
import { errorMessage } from "../../settings-forms";
import { Empty, ErrorText, SectionHeader } from "./parts";

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
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        onClick={() => setDialog("remove")}
      >
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

/** Connections with their token status only; tokens are never sent to the browser. */
export function ConnectionsSection() {
  const connections = useQuery(connectionsQuery);
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto">
      <SectionHeader title="Connections" />
      {connections.isPending ? (
        <Empty>Loading connections…</Empty>
      ) : connections.isError ? (
        <Empty>{connections.error.message}</Empty>
      ) : connections.data.length === 0 ? (
        <Empty>No connections yet. Starting a task against a new host asks for a token.</Empty>
      ) : (
        <ul className="m-0 list-none p-0">
          {connections.data.map((connection) => (
            <ConnectionRow key={connection.id} connection={connection} />
          ))}
        </ul>
      )}
    </div>
  );
}
