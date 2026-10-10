import {
  AGENT_ROLES,
  type Agent,
  type AgentRole,
  type GeneralSettings,
  type RoleAgents,
} from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { setRoleDefaults, updateSettings } from "../../api";
import { cn } from "../../lib/utils";
import { agentsQuery, queryKeys, roleDefaultsQuery, settingsQuery } from "../../query";
import {
  ROLE_LABELS,
  agentsForRole,
  errorMessage,
  isPanelRole,
  parseCap,
  roleIds,
  sameRoles,
  withRole,
} from "../../settings-forms";
import { editorBody, sectionLegend } from "../classes";
import { CheckChip } from "../ui/check-chip";
import { fieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Empty, SaveBar, SectionHeader } from "./parts";

function DefaultsEditor({
  agents,
  savedRoles,
  savedSettings,
}: {
  agents: Agent[];
  savedRoles: RoleAgents;
  savedSettings: GeneralSettings;
}) {
  const queryClient = useQueryClient();
  const [roles, setRoles] = useState(savedRoles);
  const [cap, setCap] = useState(String(savedSettings.maxTasksPerRepo));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const capValue = parseCap(cap);
  const rolesDirty = !sameRoles(roles, savedRoles);
  const capDirty = capValue !== savedSettings.maxTasksPerRepo;
  const dirty = rolesDirty || capDirty;

  function setRole(role: AgentRole, ids: string[]) {
    setRoles((current) => withRole(current, role, ids));
  }

  async function save() {
    if (!dirty || saving) return;
    if (capValue === null) {
      setError("The concurrency cap must be a whole number from 1 to 20");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (rolesDirty) {
        queryClient.setQueryData(queryKeys.roleDefaults, await setRoleDefaults(roles));
      }
      if (capDirty) {
        queryClient.setQueryData(
          queryKeys.settings,
          await updateSettings({ maxTasksPerRepo: capValue }),
        );
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className={cn(editorBody, "gap-6")}>
        <fieldset className="m-0 flex max-w-[720px] flex-col gap-4 border-none p-0">
          <legend className={sectionLegend}>Agent per role</legend>
          <p className="m-0 text-meta text-muted-foreground">
            New tasks start with these agents, on their repo&apos;s default CLI.
          </p>
          {AGENT_ROLES.map((role) => {
            const eligible = agentsForRole(agents, role);
            const chosen = roleIds(roles, role);
            const id = `role-${role}`;
            if (!isPanelRole(role)) {
              return (
                <div key={role} className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-3">
                  <label htmlFor={id} className={fieldLabel}>
                    {ROLE_LABELS[role]}
                  </label>
                  <Select
                    id={id}
                    value={chosen[0] ?? ""}
                    onChange={(event) => setRole(role, [event.target.value])}
                  >
                    <option value="">None (choose per task)</option>
                    {eligible.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            }
            return (
              <fieldset
                key={role}
                className="m-0 grid grid-cols-[140px_minmax(0,1fr)] items-start gap-3 border-none p-0"
              >
                <legend className="sr-only">{ROLE_LABELS[role]}</legend>
                <span aria-hidden="true" className={cn(fieldLabel, "pt-1")}>
                  {ROLE_LABELS[role]}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {eligible.length === 0 && (
                    <span className="pt-1 text-meta text-faint">
                      No agent is eligible for this stage.
                    </span>
                  )}
                  {eligible.map((agent) => (
                    <CheckChip
                      key={agent.id}
                      checked={chosen.includes(agent.id)}
                      onCheckedChange={(checked) =>
                        setRole(
                          role,
                          checked ? [...chosen, agent.id] : chosen.filter((c) => c !== agent.id),
                        )
                      }
                    >
                      {agent.name}
                    </CheckChip>
                  ))}
                </div>
              </fieldset>
            );
          })}
        </fieldset>

        <fieldset className="m-0 flex max-w-[720px] flex-col gap-3 border-none p-0">
          <legend className={sectionLegend}>Concurrency</legend>
          <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-3">
            <label htmlFor="max-tasks-per-repo" className={fieldLabel}>
              Tasks per repo
            </label>
            <div className="flex items-center gap-3">
              <Input
                id="max-tasks-per-repo"
                type="number"
                min={1}
                max={20}
                className="mono w-20"
                aria-invalid={capValue === null}
                value={cap}
                onChange={(event) => setCap(event.target.value)}
              />
              <span className="text-meta text-muted-foreground">
                Running at once in one repo. Tasks waiting on you don&apos;t take a slot.
              </span>
            </div>
          </div>
        </fieldset>
      </div>
      <SaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        onDiscard={() => {
          setRoles(savedRoles);
          setCap(String(savedSettings.maxTasksPerRepo));
          setError(null);
        }}
        onSave={() => void save()}
      />
    </>
  );
}

/** The role defaults and the concurrency cap per repo. */
export function DefaultsSection() {
  const agents = useQuery(agentsQuery);
  const roles = useQuery(roleDefaultsQuery);
  const settings = useQuery(settingsQuery);
  const error = agents.error ?? roles.error ?? settings.error;
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <SectionHeader title="Defaults" />
      {error ? (
        <Empty>{error.message}</Empty>
      ) : !agents.data || !roles.data || !settings.data ? (
        <Empty>Loading defaults…</Empty>
      ) : (
        <DefaultsEditor
          // Re-keyed when the stored values change (after a save, or an agent edit elsewhere).
          key={JSON.stringify([roles.data, settings.data])}
          agents={agents.data}
          savedRoles={roles.data}
          savedSettings={settings.data}
        />
      )}
    </div>
  );
}
