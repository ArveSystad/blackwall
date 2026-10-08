import { APP_NAME, type ConnectionKind } from "@blackwall/shared";
import { useEffect, useState, type FormEvent } from "react";
import {
  MissingCredentialError,
  connectSocket,
  fetchHealth,
  resolveConnection,
  testConnection,
} from "./api";
import { CredentialProvider } from "./components/CredentialProvider";
import { useWithCredential } from "./credentials";

type Status =
  { state: "pending" } | { state: "ok"; detail: string } | { state: "error"; detail: string };

function useHealth(): Status {
  const [status, setStatus] = useState<Status>({ state: "pending" });
  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((health) => setStatus({ state: "ok", detail: health.status }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setStatus({ state: "error", detail: String(error) });
      });
    return () => controller.abort();
  }, []);
  return status;
}

function useSocketPing(): Status {
  const [status, setStatus] = useState<Status>({ state: "pending" });
  useEffect(() => {
    const sentAt = new Map<string, number>();
    const socket = connectSocket({
      onOpen: () => {
        const id = crypto.randomUUID();
        sentAt.set(id, performance.now());
        socket.send({ type: "ping", payload: { id } });
      },
      onEvent: (event) => {
        if (event.type === "pong") {
          const started = sentAt.get(event.payload.id);
          if (started === undefined) return;
          setStatus({
            state: "ok",
            detail: `pong in ${Math.round(performance.now() - started)} ms`,
          });
        } else if (event.type === "error") {
          setStatus({ state: "error", detail: event.payload.message });
        }
      },
      onClose: () =>
        setStatus((current) =>
          current.state === "ok" ? current : { state: "error", detail: "connection closed" },
        ),
    });
    return () => socket.close();
  }, []);
  return status;
}

function describe(status: Status): string {
  return status.state === "pending" ? "checking…" : `${status.state}: ${status.detail}`;
}

/**
 * Resolves the connection for a git remote or Jira URL and tests it. Without a
 * connection or token this opens the missing-token modal, then retries.
 * Placeholder until the real screens land (task-008, task-009).
 */
function ConnectionCheck() {
  const withCredential = useWithCredential();
  const [kind, setKind] = useState<ConnectionKind>("github");
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState<Status | null>(null);

  async function check(event: FormEvent) {
    event.preventDefault();
    const value = address.trim();
    if (!value) return;
    setStatus({ state: "pending" });
    try {
      const result = await withCredential(
        { label: "Check connection", target: value },
        async () => {
          const connection = await resolveConnection(
            kind === "github" ? { kind, remote: value } : { kind, url: value },
          );
          return testConnection(connection.id);
        },
      );
      setStatus(
        result.ok
          ? { state: "ok", detail: `signed in as ${result.account}` }
          : { state: "error", detail: result.message },
      );
    } catch (error) {
      const detail =
        error instanceof MissingCredentialError
          ? `cancelled, ${error.message.toLowerCase()}`
          : error instanceof Error
            ? error.message
            : String(error);
      setStatus({ state: "error", detail });
    }
  }

  return (
    <form onSubmit={(event) => void check(event)}>
      <h2>Connection</h2>
      <label>
        <input
          type="radio"
          name="kind"
          checked={kind === "github"}
          onChange={() => setKind("github")}
        />{" "}
        Git remote
      </label>{" "}
      <label>
        <input
          type="radio"
          name="kind"
          checked={kind === "jira"}
          onChange={() => setKind("jira")}
        />{" "}
        Jira URL
      </label>
      <p>
        <input
          className="input mono"
          aria-label={kind === "github" ? "Git remote" : "Jira URL"}
          placeholder={
            kind === "github" ? "git@github.com:owner/repo.git" : "https://acme.atlassian.net"
          }
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
      </p>
      <button className="btn" type="submit" disabled={status?.state === "pending"}>
        Check connection
      </button>
      {status && <p data-state={status.state}>{describe(status)}</p>}
    </form>
  );
}

export function App() {
  const health = useHealth();
  const ping = useSocketPing();
  return (
    <CredentialProvider>
      <main>
        <h1>{APP_NAME}</h1>
        <dl>
          <dt>API</dt>
          <dd data-state={health.state}>{describe(health)}</dd>
          <dt>WebSocket</dt>
          <dd data-state={ping.state}>{describe(ping)}</dd>
        </dl>
        <ConnectionCheck />
      </main>
    </CredentialProvider>
  );
}
