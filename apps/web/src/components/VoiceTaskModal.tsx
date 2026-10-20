import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { clearVoiceDraft } from "../api";
import { voiceQuery } from "../query";
import { useVoiceDraftHosted } from "../voice-draft-host";
import { NewTaskModal } from "./NewTaskModal";

/**
 * The New task form a voice command opened, in every tab: shown while the
 * server holds a voice draft, and gone once it is created or closed anywhere,
 * unless a hand-opened New task form in this tab hosts the draft. Closing it here closes the draft for every tab; the form itself never
 * submits on its own.
 */
export function VoiceTaskModal() {
  const voice = useQuery(voiceQuery);
  const hosted = useVoiceDraftHosted();
  // Hidden at once on close, before the server's change arrives.
  const [closedId, setClosedId] = useState<string | null>(null);
  const draft = voice.data?.draft;
  if (hosted || !draft || draft.id === closedId) return null;
  return (
    <NewTaskModal
      key={draft.id}
      open
      voiceDraft={draft}
      onClose={() => {
        setClosedId(draft.id);
        void clearVoiceDraft(draft.id).catch(() => undefined);
      }}
    />
  );
}
