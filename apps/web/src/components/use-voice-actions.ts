import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { setChatOpen } from "../chat";
import { voiceQuery } from "../query";
import { selectRepo } from "../selected-repo";
import { pendingVoiceActions, VOICE_CLIENT_ID } from "../voice";

/**
 * Applies the UI actions of this tab's voice commands, each once: the grid
 * wall, a repo switch, the chat panel and opening a task. Other tabs and
 * earlier page loads leave them alone.
 */
export function useVoiceActions(): void {
  const voice = useQuery(voiceQuery);
  const navigate = useNavigate();
  const applied = useRef(new Set<string>());

  useEffect(() => {
    if (!voice.data) return;
    for (const action of pendingVoiceActions(voice.data, VOICE_CLIENT_ID, applied.current)) {
      applied.current.add(action.id);
      switch (action.kind) {
        case "show-grid":
          void navigate({ to: "/" });
          break;
        case "select-repo":
          selectRepo(navigate, action.repoId);
          break;
        case "open-chat":
          setChatOpen(true);
          break;
        case "open-task":
          void navigate({ to: "/tasks/$taskId", params: { taskId: action.taskId } });
          break;
      }
    }
  }, [voice.data, navigate]);
}
