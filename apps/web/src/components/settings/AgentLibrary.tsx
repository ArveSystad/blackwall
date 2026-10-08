import { stagePermissionProfile, type Agent } from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createAgent, deleteAgent, updateAgent } from "../../api";
import { cn } from "../../lib/utils";
import { agentsQuery, queryKeys } from "../../query";
import {
  AGENT_STAGES,
  CLI_NAMES,
  agentDraft,
  copyName,
  draftToInput,
  errorMessage,
  sameDraft,
  stageLabel,
  type AgentDraft,
} from "../../settings-forms";
import { AgentTile } from "../AgentTile";
import { ConfirmDialog } from "../ConfirmDialog";
import { Segmented } from "../Segmented";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Empty, SaveBar, SectionHeader, fieldLabel } from "./parts";

/** What the editor shows: an existing agent, or a new one (blank or a duplicate). */
type Editing = { kind: "agent"; id: string } | { kind: "new"; draft: AgentDraft; key: string };

const newDraft = (draft: AgentDraft): Editing => ({ kind: "new", draft, key: crypto.randomUUID() });

function permissionSummary(stages: readonly Agent["eligibleStages"][number][]): string {
  const profiles = new Set(stages.map(stagePermissionProfile));
  if (profiles.size === 0) return "No stages yet";
  if (profiles.size === 2) return "Implement: edit + shell · other stages: read-only";
  return profiles.has("implement") ? "Edit + shell" : "Read-only";
}

function AgentEditor({
  agent,
  initial,
  taken,
  onSaved,
  onDuplicate,
  onDeleted,
}: {
  /** The agent being edited; undefined for a new one. */
  agent?: Agent;
  initial: AgentDraft;
  /** Names of the other agents, for Duplicate. */
  taken: string[];
  onSaved: (agent: Agent) => void;
  onDuplicate: (draft: AgentDraft) => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isNew = agent === undefined;
  const dirty = isNew || !sameDraft(draft, initial);
  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  async function save() {
    if (!dirty || saving) return;
    if (!draft.name.trim()) {
      setError("Give the agent a name");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const input = draftToInput(draft);
      const saved = isNew ? await createAgent(input) : await updateAgent(agent.id, input);
      // Role defaults may have dropped the agent; ["agents"] covers them too.
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents });
      onSaved(saved);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function toggleStage(stage: AgentDraft["eligibleStages"][number], on: boolean) {
    set(
      "eligibleStages",
      on ? [...draft.eligibleStages, stage] : draft.eligibleStages.filter((s) => s !== stage),
    );
  }

  return (
    <section aria-label="Edit agent" className="flex min-w-0 flex-1 flex-col bg-sidebar">
      <div className="flex min-h-[52px] items-center gap-2.5 border-b border-border px-5 py-3">
        <AgentTile cli={draft.cli} size="lg" />
        <span className="truncate text-heading font-semibold text-foreground-strong">
          {draft.name.trim() || (isNew ? "New agent" : agent.name)}
        </span>
        {isNew && <span className="text-meta text-muted-foreground">not saved yet</span>}
        <span className="flex-1" />
        {!isNew && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                onDuplicate({ ...draft, name: copyName(draft.name.trim() || agent.name, taken) })
              }
            >
              Duplicate
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          </>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto px-5 py-[18px]">
        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Name</span>
            <Input
              value={draft.name}
              autoFocus={isNew}
              onChange={(event) => set("name", event.target.value)}
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className={fieldLabel}>CLI</span>
            <Segmented
              label="CLI"
              value={draft.cli}
              onChange={(cli) => set("cli", cli)}
              options={(["claude", "copilot"] as const).map((cli) => ({
                value: cli,
                label: (
                  <>
                    <AgentTile cli={cli} />
                    {CLI_NAMES[cli]}
                  </>
                ),
              }))}
            />
          </div>
          <label className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Model</span>
            <Input
              className="mono"
              spellCheck={false}
              placeholder="CLI default"
              value={draft.model}
              onChange={(event) => set("model", event.target.value)}
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Permission profile</span>
            <span className="flex h-[30px] items-center text-muted-foreground">
              {permissionSummary(draft.eligibleStages)}
            </span>
          </div>
        </div>

        <fieldset className="m-0 border-none p-0">
          <legend className={cn(fieldLabel, "mb-2 p-0")}>Eligible stages</legend>
          <div className="flex flex-wrap gap-1.5">
            {AGENT_STAGES.map(({ stage, label }) => {
              const on = draft.eligibleStages.includes(stage);
              return (
                <label
                  key={stage}
                  className={cn(
                    "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-sm border border-input px-2.5 text-[12.5px] font-medium text-muted-foreground has-focus-visible:shadow-ring",
                    on && "border-primary text-foreground-strong",
                  )}
                >
                  <input
                    type="checkbox"
                    className="accent-primary focus:outline-none"
                    checked={on}
                    onChange={(event) => toggleStage(stage, event.target.checked)}
                  />
                  {label}
                </label>
              );
            })}
          </div>
        </fieldset>

        <label className="flex min-h-[260px] flex-1 flex-col gap-1.5">
          <span className="flex items-center gap-2">
            <span className={fieldLabel}>Prompt</span>
            <span className="text-meta text-faint">
              Persona for every stage. Code reviewers also get the tag list and findings format.
            </span>
          </span>
          <Textarea
            className="mono min-h-[220px] flex-1 bg-code text-code"
            spellCheck={false}
            value={draft.prompt}
            onChange={(event) => set("prompt", event.target.value)}
          />
        </label>

        <fieldset className="m-0 grid grid-cols-1 gap-3.5 border-none p-0 lg:grid-cols-2">
          <legend className={cn(fieldLabel, "mb-1 p-0")}>Permission overrides</legend>
          <p className="col-span-full m-0 text-meta text-muted-foreground">
            Extra rules on top of the stage profile, one per line in the CLI&apos;s own syntax (
            <span className="mono">
              {draft.cli === "claude" ? "Bash(npm test:*)" : "shell(npm test)"}
            </span>
            ). Deny always wins: an allow cannot lift a built-in deny such as{" "}
            <span className="mono">git push</span>.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-meta text-muted-foreground">Allow</span>
            <Textarea
              className="mono min-h-20 text-code"
              spellCheck={false}
              value={draft.allow}
              onChange={(event) => set("allow", event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-meta text-muted-foreground">Deny</span>
            <Textarea
              className="mono min-h-20 text-code"
              spellCheck={false}
              value={draft.deny}
              onChange={(event) => set("deny", event.target.value)}
            />
          </label>
        </fieldset>
      </div>

      <SaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        saveLabel={isNew ? "Create agent" : "Save"}
        onDiscard={() => {
          if (isNew) onDeleted();
          else setDraft(initial);
          setError(null);
        }}
        onSave={() => void save()}
      />

      {confirmDelete && !isNew && (
        <ConfirmDialog
          title={`Delete ${agent.name}?`}
          confirmLabel="Delete agent"
          onConfirm={async () => {
            await deleteAgent(agent.id);
            await queryClient.invalidateQueries({ queryKey: queryKeys.agents });
            onDeleted();
          }}
          onClose={() => setConfirmDelete(false)}
        >
          It is removed from the library and from the role defaults. Past steps keep their output.
        </ConfirmDialog>
      )}
    </section>
  );
}

/** Agent library: the agents beside the selected agent's editor. */
export function AgentLibrary() {
  const agents = useQuery(agentsQuery);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);

  const list = agents.data ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? list.filter(
        (a) =>
          a.name.toLowerCase().includes(needle) || (a.model ?? "").toLowerCase().includes(needle),
      )
    : list;
  const selected =
    editing?.kind === "agent"
      ? list.find((a) => a.id === editing.id)
      : editing
        ? undefined
        : list[0];
  const names = list.map((a) => a.name);

  return (
    <>
      <section
        aria-label="Agents"
        className="flex w-[360px] shrink-0 flex-col border-r border-border"
      >
        <div className="flex flex-col gap-2.5 border-b border-border">
          <SectionHeader title="Agent library">
            <Button size="sm" variant="primary" onClick={() => setEditing(newDraft(agentDraft()))}>
              + New agent
            </Button>
          </SectionHeader>
          <div className="px-3.5 pb-2.5">
            <Input
              type="search"
              className="h-7"
              placeholder="Filter agents"
              aria-label="Filter agents"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
        </div>
        {agents.isPending ? (
          <Empty>Loading agents…</Empty>
        ) : agents.isError ? (
          <Empty>{agents.error.message}</Empty>
        ) : list.length === 0 ? (
          <Empty>No agents. Add one to plan, implement or review tasks.</Empty>
        ) : shown.length === 0 ? (
          <Empty>No agents match “{filter.trim()}”.</Empty>
        ) : (
          <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-auto p-1.5">
            {shown.map((agent) => {
              const current = agent.id === selected?.id;
              return (
                <li key={agent.id}>
                  <button
                    type="button"
                    aria-current={current ? "true" : undefined}
                    onClick={() => setEditing({ kind: "agent", id: agent.id })}
                    className={cn(
                      "flex w-full cursor-pointer flex-col gap-1 rounded-lg border border-transparent bg-transparent px-2.5 py-[9px] text-left text-foreground hover:bg-card focus-visible:shadow-ring focus-visible:outline-none",
                      current && "border-border-strong bg-muted hover:bg-muted",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <AgentTile cli={agent.cli} />
                      <span className="truncate font-medium text-foreground-strong">
                        {agent.name}
                      </span>
                      <span className="flex-1" />
                      <span className="mono text-label text-faint">{agent.model ?? "default"}</span>
                    </span>
                    <span className="flex flex-wrap gap-1 pl-6">
                      {agent.eligibleStages.length === 0 ? (
                        <span className="text-label text-faint">No stages</span>
                      ) : (
                        agent.eligibleStages.map((stage) => (
                          <span
                            key={stage}
                            className="mono inline-flex h-[18px] items-center rounded-xs bg-muted px-[5px] text-label text-muted-foreground"
                          >
                            {stageLabel(stage).toLowerCase()}
                          </span>
                        ))
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {editing?.kind === "new" ? (
        <AgentEditor
          // A fresh form per new draft.
          key={editing.key}
          initial={editing.draft}
          taken={names}
          onSaved={(agent) => setEditing({ kind: "agent", id: agent.id })}
          onDuplicate={() => undefined}
          onDeleted={() => setEditing(null)}
        />
      ) : selected ? (
        <AgentEditor
          key={selected.id}
          agent={selected}
          initial={agentDraft(selected)}
          taken={names}
          onSaved={() => undefined}
          onDuplicate={(draft) => setEditing(newDraft(draft))}
          onDeleted={() => setEditing(null)}
        />
      ) : (
        <div className="flex-1 bg-sidebar" />
      )}
    </>
  );
}
