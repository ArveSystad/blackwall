import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { BackIcon } from "../components/icons";
import { BacklogSection } from "../components/settings/BacklogSection";
import { AgentLibrary } from "../components/settings/AgentLibrary";
import { ConnectionsSection } from "../components/settings/ConnectionsSection";
import { DataSection } from "../components/settings/DataSection";
import { DefaultsSection } from "../components/settings/DefaultsSection";
import { NotificationsSection } from "../components/settings/NotificationsSection";
import { RepositoriesSection } from "../components/settings/RepositoriesSection";
import { SystemSection } from "../components/settings/SystemSection";
import { TagsSection } from "../components/settings/TagsSection";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { useEscapeTo } from "../keyboard";
import { agentsQuery, connectionsQuery, reposQuery, tagsQuery } from "../query";
import { SETTINGS_SECTIONS, type SettingsSection } from "../settings-sections";

function NavCount({ section }: { section: SettingsSection }) {
  const connections = useQuery({ ...connectionsQuery, enabled: section === "connections" });
  const repos = useQuery({ ...reposQuery, enabled: section === "repositories" });
  const agents = useQuery({ ...agentsQuery, enabled: section === "agents" });
  const tags = useQuery({ ...tagsQuery, enabled: section === "tags" });
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
  if (section === "agents" && agents.data) {
    return <span className="mono text-label text-faint">{agents.data.length}</span>;
  }
  if (section === "tags" && tags.data) {
    return <span className="mono text-label text-faint">{tags.data.length}</span>;
  }
  return null;
}

function SectionBody({ section }: { section: SettingsSection }) {
  switch (section) {
    case "connections":
      return <ConnectionsSection />;
    case "repositories":
      return <RepositoriesSection />;
    case "agents":
      return <AgentLibrary />;
    case "tags":
      return <TagsSection />;
    case "defaults":
      return <DefaultsSection />;
    case "backlog":
      return <BacklogSection />;
    case "notifications":
      return <NotificationsSection />;
    case "data":
      return <DataSection />;
    case "system":
      return <SystemSection />;
  }
}

/** Settings replaces both panes: a section nav on the left, the section on the right. */
export function Settings({ section }: { section: SettingsSection }) {
  const navigate = useNavigate();

  useEscapeTo(() => void navigate({ to: "/" }));

  return (
    <div className="flex h-full min-w-0">
      <nav
        aria-label="Settings"
        className="flex h-full w-[352px] shrink-0 flex-col gap-0.5 border-r border-border bg-sidebar px-2.5 py-3"
      >
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
            className="justify-start text-foreground data-[status=active]:bg-muted data-[status=active]:[--bw-chamfer-line:var(--border-strong)] data-[status=active]:text-foreground-strong"
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
      <main className="flex h-full min-w-0 flex-1 bg-background">
        <SectionBody section={section} />
      </main>
    </div>
  );
}
