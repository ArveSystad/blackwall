import { AGENT_CLIS, stagePermissionProfile, type Agent, type AgentCli } from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { createAgent, deleteAgent, updateAgent } from "../../api";
import { cn } from "../../lib/utils";
import { agentsQuery, queryKeys } from "../../query";
import {
  AGENT_STAGES,
  CLI_NAMES,
  MODEL_PRESETS,
  OVERRIDE_EXAMPLES,
  agentDraft,
  copyName,
  draftToInput,
  errorMessage,
  isPresetModel,
  overrideCount,
  sameDraft,
  stageLabel,
  type AgentDraft,
} from "../../settings-forms";
import { AUTO_MODEL_LABEL } from "../../task-view";
import { AgentTile } from "../AgentTile";
import {
  editorBody,
  listPane,
  paneHeader,
  paneTitle,
  rowSelectable,
  rowSelected,
  sideList,
} from "../classes";
import { ConfirmDialog } from "../ConfirmDialog";
import { PlusIcon } from "../icons";
import { CliStatusList } from "./CliStatusList";
import { Segmented } from "../Segmented";
import { Button } from "../ui/button";
import { CheckChip } from "../ui/check-chip";
import { Tag } from "../ui/chip";
import { Field, fieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Empty, SaveBar, SectionHeader } from "./parts";

/** What the editor shows: an existing agent, or a new one (blank or a duplicate). */
type Editing = { kind: "agent"; id: string } | { kind: "new"; draft: AgentDraft; key: string };

/** The Model select's value for Custom…; never stored. */
const CUSTOM_MODEL = "__custom";

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
  // CLIs whose Custom… was picked before an id outside the presets was typed.
  const [customPicked, setCustomPicked] = useState<Partial<Record<AgentCli, boolean>>>({});
  const customId = useId();
  const [overridesCli, setOverridesCli] = useState<AgentCli>(
    () => AGENT_CLIS.find((cli) => overrideCount(initial, cli) > 0) ?? "claude",
  );

  const isNew = agent === undefined;
  const customMode = (cli: AgentCli) =>
    !!customPicked[cli] || (draft.models[cli] !== "" && !isPresetModel(cli, draft.models[cli]));
  const dirty = isNew || !sameDraft(draft, initial);
  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  /** Sets one CLI's entry of a per-CLI field. */
  const setFor = (key: "models" | "allow" | "deny", cli: AgentCli, value: string) =>
    setDraft((d) => ({ ...d, [key]: { ...d[key], [cli]: value } }));

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
      <div className={paneHeader}>
        <span className={paneTitle}>{draft.name.trim() || (isNew ? "New agent" : agent.name)}</span>
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
            <Button size="sm" variant="destructive-ghost" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        )}
      </div>

      <div className={editorBody}>
        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
          <Field label="Name">
            <Input
              value={draft.name}
              autoFocus={isNew}
              onChange={(event) => set("name", event.target.value)}
            />
          </Field>
          <Field label="Permission profile" group>
            <span className="flex h-[30px] items-center text-muted-foreground">
              {permissionSummary(draft.eligibleStages)}
            </span>
          </Field>
        </div>

        <fieldset className="m-0 grid grid-cols-1 gap-3.5 border-none p-0 lg:grid-cols-2">
          <legend className={cn(fieldLabel, "mb-1 p-0")}>Model</legend>
          <p className="col-span-full m-0 text-meta text-muted-foreground">
            The agent runs on its task&apos;s CLI. Leave a model blank to use that CLI&apos;s
            default.
          </p>
          {AGENT_CLIS.map((cli) => (
            <Field key={cli} label={CLI_NAMES[cli]}>
              <Select
                value={customMode(cli) ? CUSTOM_MODEL : draft.models[cli]}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === CUSTOM_MODEL) {
                    setCustomPicked((c) => ({ ...c, [cli]: true }));
                    if (isPresetModel(cli, draft.models[cli])) setFor("models", cli, "");
                  } else {
                    setCustomPicked((c) => ({ ...c, [cli]: false }));
                    setFor("models", cli, value);
                  }
                }}
              >
                <option value="">Auto (CLI default)</option>
                {MODEL_PRESETS[cli].map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
                <option value={CUSTOM_MODEL}>Custom…</option>
              </Select>
              {customMode(cli) && (
                <Input
                  id={`${customId}-${cli}`}
                  className="mono"
                  spellCheck={false}
                  placeholder="Model id"
                  aria-label={`Custom ${CLI_NAMES[cli]} model`}
                  value={draft.models[cli]}
                  onChange={(event) => setFor("models", cli, event.target.value)}
                />
              )}
            </Field>
          ))}
        </fieldset>

        <fieldset className="m-0 border-none p-0">
          <legend className={cn(fieldLabel, "mb-2 p-0")}>Eligible stages</legend>
          <div className="flex flex-wrap gap-1.5">
            {AGENT_STAGES.map(({ stage, label }) => (
              <CheckChip
                key={stage}
                checked={draft.eligibleStages.includes(stage)}
                onCheckedChange={(checked) => toggleStage(stage, checked)}
              >
                {label}
              </CheckChip>
            ))}
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
          <div className="col-span-full">
            <Segmented
              label="Overrides for CLI"
              value={overridesCli}
              onChange={setOverridesCli}
              options={AGENT_CLIS.map((cli) => {
                const count = overrideCount(draft, cli);
                return {
                  value: cli,
                  label: (
                    <>
                      {CLI_NAMES[cli]}
                      {count > 0 && <span className="mono text-label text-faint">{count}</span>}
                    </>
                  ),
                };
              })}
            />
          </div>
          <p className="col-span-full m-0 text-meta text-muted-foreground">
            Extra rules on top of the stage profile, one per line in the CLI&apos;s own syntax (
            <span className="mono">{OVERRIDE_EXAMPLES[overridesCli]}</span>
            ). Deny always wins: an allow cannot lift a built-in deny such as{" "}
            <span className="mono">git push</span>.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-meta text-muted-foreground">Allow</span>
            <Textarea
              className="mono min-h-20 text-code"
              spellCheck={false}
              value={draft.allow[overridesCli]}
              onChange={(event) => setFor("allow", overridesCli, event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-meta text-muted-foreground">Deny</span>
            <Textarea
              className="mono min-h-20 text-code"
              spellCheck={false}
              value={draft.deny[overridesCli]}
              onChange={(event) => setFor("deny", overridesCli, event.target.value)}
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
          setCustomPicked({});
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

/** The models an agent has set, each with its CLI's tile; Auto when none is. */
function AgentModels({ agent }: { agent: Agent }) {
  const set = AGENT_CLIS.flatMap((cli) => {
    const model = agent.models[cli];
    return model ? [{ cli, model }] : [];
  });
  if (set.length === 0) {
    return <span className="mono text-label text-faint">{AUTO_MODEL_LABEL}</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-label text-faint">
      {set.map(({ cli, model }, i) => (
        <span key={cli} className="inline-flex min-w-0 items-center gap-1">
          {i > 0 && <span aria-hidden="true">·</span>}
          <AgentTile cli={cli} />
          <span className="mono truncate">{model}</span>
        </span>
      ))}
    </span>
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
          a.name.toLowerCase().includes(needle) ||
          Object.values(a.models).some((model) => model.toLowerCase().includes(needle)),
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
      <section aria-label="Agents" className={listPane}>
        <div className="flex flex-col gap-2.5 border-b border-border">
          <SectionHeader title="Agent library">
            <Button size="sm" variant="primary" onClick={() => setEditing(newDraft(agentDraft()))}>
              <PlusIcon />
              New agent
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
          <ul className={sideList}>
            {shown.map((agent) => {
              const current = agent.id === selected?.id;
              return (
                <li key={agent.id}>
                  <button
                    type="button"
                    aria-current={current ? "true" : undefined}
                    onClick={() => setEditing({ kind: "agent", id: agent.id })}
                    className={cn(
                      "flex w-full cursor-pointer flex-col gap-1 bg-transparent px-2.5 py-[9px] text-left text-foreground focus-visible:shadow-ring focus-visible:outline-none",
                      rowSelectable,
                      current && rowSelected,
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium text-foreground-strong">
                        {agent.name}
                      </span>
                      <span className="flex-1" />
                      <AgentModels agent={agent} />
                    </span>
                    <span className="flex flex-wrap gap-1">
                      {agent.eligibleStages.length === 0 ? (
                        <span className="text-label text-faint">No stages</span>
                      ) : (
                        agent.eligibleStages.map((stage) => (
                          <Tag key={stage}>{stageLabel(stage).toLowerCase()}</Tag>
                        ))
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <CliStatusList />
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
