import {
  VOICE_MODEL_IDS,
  VOICE_MODELS,
  type GeneralSettings,
  type VoiceModelId,
} from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { updateSettings } from "../../api";
import { cn } from "../../lib/utils";
import { queryKeys, settingsQuery, voiceStatusQuery } from "../../query";
import { errorMessage } from "../../settings-forms";
import { editorBody, sectionLegend } from "../classes";
import { CheckIcon, WarnIcon } from "../icons";
import { Field } from "../ui/field";
import { Select } from "../ui/select";
import { Empty, SaveBar, SectionHeader } from "./parts";

function VoiceStatusLine() {
  const status = useQuery(voiceStatusQuery);
  if (status.error)
    return <span className="text-meta text-destructive">{status.error.message}</span>;
  if (!status.data) return <span className="text-meta text-muted-foreground">Checking…</span>;
  if (status.data.available) {
    return (
      <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
        <CheckIcon size="sm" className="text-done" />
        Ready: {VOICE_MODELS[status.data.model].label}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-meta text-sev-medium">
      <WarnIcon size="sm" />
      {status.data.reason}
    </span>
  );
}

function VoiceEditor({ saved }: { saved: GeneralSettings }) {
  const queryClient = useQueryClient();
  const [model, setModel] = useState<VoiceModelId>(saved.voiceModel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = model !== saved.voiceModel;

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      queryClient.setQueryData(queryKeys.settings, await updateSettings({ voiceModel: model }));
      // The new model may not be downloaded yet.
      void queryClient.invalidateQueries({ queryKey: queryKeys.voiceStatus });
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <>
      <div className={cn(editorBody, "gap-6")}>
        <fieldset className="m-0 flex max-w-[720px] flex-col gap-4 border-none p-0">
          <legend className={sectionLegend}>Speech model</legend>
          <p className="m-0 text-meta text-muted-foreground">
            Hold the mic in the top bar and speak a command. Audio is transcribed on this machine;
            only the text goes to the repo&apos;s agent CLI.
          </p>
          <VoiceStatusLine />
          <Field
            label="Model"
            hint={
              <>
                Download it with <code className="mono">pnpm voice:model {model}</code> (about{" "}
                {VOICE_MODELS[model].approxMb} MB).
              </>
            }
          >
            <Select
              className="max-w-80"
              value={model}
              onChange={(event) => setModel(event.target.value as VoiceModelId)}
            >
              {VOICE_MODEL_IDS.map((id) => (
                <option key={id} value={id}>
                  {VOICE_MODELS[id].label}
                </option>
              ))}
            </Select>
          </Field>
        </fieldset>
      </div>
      <SaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        onDiscard={() => {
          setModel(saved.voiceModel);
          setError(null);
        }}
        onSave={() => void save()}
      />
    </>
  );
}

/** Voice control: whether speech can be transcribed, and the model it uses. */
export function VoiceSection() {
  const settings = useQuery(settingsQuery);
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <SectionHeader title="Voice" />
      {settings.error ? (
        <Empty>{settings.error.message}</Empty>
      ) : !settings.data ? (
        <Empty>Reading voice settings…</Empty>
      ) : (
        <VoiceEditor key={settings.data.voiceModel} saved={settings.data} />
      )}
    </div>
  );
}
