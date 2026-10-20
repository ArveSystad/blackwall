import {
  VOICE_MODEL_IDS,
  VOICE_MODELS,
  voiceHotkeyLabel,
  voiceHotkeySchema,
  type GeneralSettings,
  type VoiceHotkey,
  type VoiceModelId,
} from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type KeyboardEvent } from "react";
import { downloadVoiceModel, updateSettings } from "../../api";
import { isMac } from "../../keyboard";
import { cn } from "../../lib/utils";
import { queryKeys, settingsQuery, voiceDownloadQuery, voiceStatusQuery } from "../../query";
import { errorMessage } from "../../settings-forms";
import { hotkeyFromEvent } from "../../voice-hotkey";
import { editorBody, sectionLegend } from "../classes";
import { CheckIcon, WarnIcon } from "../icons";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Select } from "../ui/select";
import { useDesktopPttStatus } from "../use-desktop-ptt-status";
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

const MB = 1024 * 1024;

/** Bytes as whole megabytes. */
const mb = (bytes: number) => Math.round(bytes / MB);

/** Downloads the selected model on the server, when it is not installed yet, with its progress. */
function ModelDownload({ model }: { model: VoiceModelId }) {
  const queryClient = useQueryClient();
  const status = useQuery(voiceStatusQuery);
  const download = useQuery(voiceDownloadQuery);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status.data) return null;
  if (status.data.installed.includes(model)) {
    return (
      <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
        <CheckIcon size="sm" className="text-done" />
        Installed
      </span>
    );
  }

  const state = download.data;
  const running = state?.phase === "downloading" || state?.phase === "unpacking";
  const mine = state?.model === model;
  const failed = mine && state.phase === "failed" ? state.error : null;

  async function start() {
    setStarting(true);
    setError(null);
    try {
      queryClient.setQueryData(queryKeys.voiceDownload, await downloadVoiceModel(model));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setStarting(false);
    }
  }

  let progress: string | null = null;
  if (mine && state.phase === "unpacking") progress = "Unpacking…";
  else if (mine && state.phase === "downloading") {
    const { receivedBytes, totalBytes } = state;
    progress = totalBytes
      ? `Downloading… ${mb(receivedBytes)} of ${mb(totalBytes)} MB (${Math.floor((receivedBytes / totalBytes) * 100)}%)`
      : `Downloading… ${mb(receivedBytes)} MB`;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={running || starting} onClick={() => void start()}>
          {failed ? "Retry" : `Download (about ${VOICE_MODELS[model].approxMb} MB)`}
        </Button>
        {progress && (
          <span className="text-meta text-muted-foreground tabular-nums">{progress}</span>
        )}
      </div>
      {(error ?? failed) && <span className="text-meta text-destructive">{error ?? failed}</span>}
    </div>
  );
}

/** Whether the saved key works system-wide (desktop shell) or only while the page has focus. */
function HotkeyStatusLine({ hotkey }: { hotkey: VoiceHotkey | null }) {
  const desktop = useDesktopPttStatus();
  if (!hotkey) return null;
  if (!desktop) {
    return <span className="text-meta text-muted-foreground">Works while blackwall has focus</span>;
  }
  if (desktop.active) {
    return (
      <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
        <CheckIcon size="sm" className="text-done" />
        Works system-wide
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-meta text-sev-medium">
      <WarnIcon size="sm" />
      {desktop.reason ?? "Works while blackwall has focus"}
    </span>
  );
}

/** Records the hold-to-talk key: click, then press the chord; Escape cancels. */
function HotkeyField({
  value,
  saved,
  onChange,
}: {
  value: VoiceHotkey | null;
  saved: VoiceHotkey | null;
  onChange: (hotkey: VoiceHotkey | null) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  function stopRecording() {
    setRecording(false);
    setHint(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!recording || event.key === "Tab") return;
    // Keeps window shortcuts (⌘S save, ⌘K search) from firing while a chord is tried.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopRecording();
      return;
    }
    const chord = hotkeyFromEvent(event);
    if (!chord) return;
    const parsed = voiceHotkeySchema.safeParse(chord);
    if (!parsed.success) {
      setHint(parsed.error.issues[0]?.message ?? "That key cannot be used");
      return;
    }
    onChange(parsed.data);
    stopRecording();
  }

  return (
    <Field
      group
      label="Hold-to-talk key"
      hint={`Use an F-key or a chord with Ctrl, Alt or ${isMac() ? "⌘" : "Win"}. It also works in text fields and while a dialog is open, where the mic button can't be reached. Alt/Option chords that type a symbol don't work in text fields.`}
    >
      <div className="flex items-center gap-2">
        <Button
          role="combobox"
          aria-expanded={recording}
          className="min-w-40 justify-center"
          onClick={() => (recording ? stopRecording() : setRecording(true))}
          onKeyDown={onKeyDown}
          onBlur={stopRecording}
        >
          {recording ? "Press a key…" : value ? voiceHotkeyLabel(value, isMac()) : "None"}
        </Button>
        {value && (
          <Button
            variant="ghost"
            onClick={() => {
              onChange(null);
              stopRecording();
            }}
          >
            Clear
          </Button>
        )}
      </div>
      {hint && <span className="text-meta text-sev-medium">{hint}</span>}
      <HotkeyStatusLine hotkey={saved} />
    </Field>
  );
}

function VoiceEditor({ saved }: { saved: GeneralSettings }) {
  const queryClient = useQueryClient();
  const [model, setModel] = useState<VoiceModelId>(saved.voiceModel);
  const [hotkey, setHotkey] = useState<VoiceHotkey | null>(saved.voiceHotkey);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty =
    model !== saved.voiceModel || JSON.stringify(hotkey) !== JSON.stringify(saved.voiceHotkey);

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      queryClient.setQueryData(
        queryKeys.settings,
        await updateSettings({ voiceModel: model, voiceHotkey: hotkey }),
      );
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
            Hold the mic in the top bar, or the hold-to-talk key below, and speak a command. Audio
            is transcribed on this machine; only the text goes to the repo&apos;s agent CLI. Set a
            hold-to-talk key to talk while a dialog is open.
          </p>
          <VoiceStatusLine />
          <Field label="Model">
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
          <ModelDownload key={model} model={model} />
          <HotkeyField value={hotkey} saved={saved.voiceHotkey} onChange={setHotkey} />
        </fieldset>
      </div>
      <SaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        onDiscard={() => {
          setModel(saved.voiceModel);
          setHotkey(saved.voiceHotkey);
          setError(null);
        }}
        onSave={() => void save()}
      />
    </>
  );
}

/** Voice control: whether speech can be transcribed, the model it uses and the hold-to-talk key. */
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
        <VoiceEditor
          key={`${settings.data.voiceModel}|${JSON.stringify(settings.data.voiceHotkey)}`}
          saved={settings.data}
        />
      )}
    </div>
  );
}
