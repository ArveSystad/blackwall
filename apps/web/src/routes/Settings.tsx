import type { ConnectionView } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { MissingCredentialError, testConnection } from "../api";
import { BackIcon, WarnIcon } from "../components/icons";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { Wordmark } from "../components/Wordmark";
import { useWithCredential } from "../credentials";
import { isPlainKey, isTypingTarget } from "../keyboard";
import { connectionsQuery, reposQuery } from "../query";
import { SETTINGS_SECTIONS, type SettingsSection } from "../settings-sections";

function NavCount({ section }: { section: SettingsSection }) {
  const connections = useQuery({ ...connectionsQuery, enabled: section === "connections" });
  const repos = useQuery({ ...reposQuery, enabled: section === "repositories" });
  if (section === "connections" && connections.data) {
    const missing = connections.data.filter((c) => !c.hasToken).length;
    return missing > 0 ? (
      <StatusBadge status="needs-you" label={`${missing} missing`} className="h-[18px]" />
    ) : (
      <span className="mono text-label text-faint">{connections.data.length}</span>
    );
  }
  if (section === "repositories" && repos.data) {
    const stale = repos.data.filter((r) => !r.exists).length;
    return stale > 0 ? (
      <span className="mono text-label text-sev-medium">{stale} stale</span>
    ) : (
      <span className="mono text-label text-faint">{repos.data.length}</span>
    );
  }
  return null;
}

type TestState =
  | { state: "idle" }
  | { state: "pending" }
  | { state: "ok"; detail: string }
  | { state: "error"; detail: string };

function ConnectionRow({ connection }: { connection: ConnectionView }) {
  const withCredential = useWithCredential();
  const [test, setTest] = useState<TestState>({ state: "idle" });

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
    } catch (error) {
      setTest({
        state: "error",
        detail:
          error instanceof MissingCredentialError
            ? "Cancelled: no token saved"
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }

  return (
    <li className="flex min-h-10 items-center gap-3 border-b border-border px-4 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium text-foreground-strong">{connection.name}</span>
        <span className="mono truncate text-muted-foreground">{connection.baseUrl}</span>
        {test.state === "ok" && <span className="text-meta text-done">{test.detail}</span>}
        {test.state === "error" && (
          <span className="text-meta text-destructive" role="alert">
            {test.detail}
          </span>
        )}
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
    </li>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="m-0 px-4 py-6 text-muted-foreground">{children}</p>;
}

function ConnectionsSection() {
  const connections = useQuery(connectionsQuery);
  if (connections.isPending) return <Empty>Loading connections…</Empty>;
  if (connections.isError) return <Empty>{connections.error.message}</Empty>;
  if (connections.data.length === 0) {
    return <Empty>No connections yet. Starting a task against a new host asks for a token.</Empty>;
  }
  return (
    <ul className="m-0 list-none p-0">
      {connections.data.map((connection) => (
        <ConnectionRow key={connection.id} connection={connection} />
      ))}
    </ul>
  );
}

function RepositoriesSection() {
  const repos = useQuery(reposQuery);
  if (repos.isPending) return <Empty>Loading repositories…</Empty>;
  if (repos.isError) return <Empty>{repos.error.message}</Empty>;
  if (repos.data.length === 0) return <Empty>No repositories registered yet.</Empty>;
  return (
    <ul className="m-0 list-none p-0">
      {repos.data.map((repo) => (
        <li
          key={repo.id}
          className="flex min-h-10 items-center gap-3 border-b border-border px-4 py-2"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium text-foreground-strong">{repo.name}</span>
            <span className="mono truncate text-muted-foreground">{repo.path}</span>
          </div>
          {!repo.exists && (
            <span className="inline-flex items-center gap-1 text-meta text-sev-medium">
              <WarnIcon size="sm" />
              Folder missing
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function SectionBody({ section }: { section: SettingsSection }) {
  switch (section) {
    case "connections":
      return <ConnectionsSection />;
    case "repositories":
      return <RepositoriesSection />;
    default:
      return <Empty>Nothing to configure here yet.</Empty>;
  }
}

/** Settings replaces both panes: a section nav on the left, the section on the right. */
export function Settings({ section }: { section: SettingsSection }) {
  const navigate = useNavigate();
  const label = SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? "";

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.key !== "Escape" || !isPlainKey(event)) return;
      if (isTypingTarget(event.target) || document.querySelector("[role=dialog]")) return;
      void navigate({ to: "/" });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return (
    <div className="flex h-full min-w-0">
      <nav
        aria-label="Settings"
        className="flex h-full w-[232px] shrink-0 flex-col gap-0.5 border-r border-border bg-sidebar px-2.5 py-3"
      >
        <div className="mb-2.5 flex h-7 items-center px-1.5">
          <Wordmark />
        </div>
        <Button variant="ghost" size="sm" className="mb-2 justify-start" asChild>
          <Link to="/">
            <BackIcon size="sm" />
            Inbox
            <span className="flex-1" />
            <Kbd>Esc</Kbd>
          </Link>
        </Button>
        <span className="label px-2 py-1 text-muted-foreground">Settings</span>
        {SETTINGS_SECTIONS.map((s) => (
          <Button
            key={s.id}
            variant="ghost"
            className="justify-start text-foreground data-[status=active]:border-border-strong data-[status=active]:bg-muted data-[status=active]:text-foreground-strong"
            asChild
          >
            <Link to="/settings/$section" params={{ section: s.id }}>
              {s.label}
              <span className="flex-1" />
              <NavCount section={s.id} />
            </Link>
          </Button>
        ))}
      </nav>
      <main className="flex min-w-0 flex-1 flex-col overflow-auto">
        <h1 className="m-0 border-b border-border px-4 py-3.5 text-heading font-semibold text-foreground-strong">
          {label}
        </h1>
        <SectionBody section={section} />
      </main>
    </div>
  );
}
