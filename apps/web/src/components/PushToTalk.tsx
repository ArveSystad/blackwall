import { voiceHotkeyLabel, type VoiceState } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ApiError, sendVoiceCommand, transcribeVoice } from "../api";
import { isMac } from "../keyboard";
import { cn } from "../lib/utils";
import { reposQuery, settingsQuery, voiceQuery, voiceStatusQuery } from "../query";
import { prefersReducedMotion } from "../reduced-motion";
import { resolveSelectedRepo, useSelectedRepoId } from "../selected-repo";
import { errorMessage } from "../settings-forms";
import { MicIcon, SpinnerIcon } from "./icons";
import { Button } from "./ui/button";
import { usePushToTalk } from "./use-push-to-talk";
import { ariaKeyShortcuts } from "../voice-hotkey";
import { usePushToTalkHotkey } from "./use-push-to-talk-hotkey";

/** How long the panel stays up once nothing is happening. */
const PANEL_LINGER_MS = 6000;

/** What the panel shows; a change brings it back up. */
function panelKey(voice: VoiceState | undefined, notice: string | null): string {
  return JSON.stringify([
    voice?.transcript,
    voice?.reply,
    voice?.error,
    voice?.created?.itemId,
    notice,
  ]);
}

/**
 * Top bar push-to-talk button for the selected repo: hold it (pointer, or
 * Space / Enter while focused, or the hold-to-talk key from Settings → Voice
 * anywhere but a text field) and speak; on release the clip is transcribed
 * on the server and sent as a voice command. A panel below shows the
 * transcript, the agent's progress and its reply, with a link to what a
 * submit created, and fades once nothing happens.
 */
export function PushToTalk({ className }: { className?: string }) {
  const repos = useQuery(reposQuery);
  const repo = resolveSelectedRepo(useSelectedRepoId(), repos.data);
  const status = useQuery(voiceStatusQuery);
  const voice = useQuery(voiceQuery);
  const settings = useQuery(settingsQuery);
  const hotkey = settings.data?.voiceHotkey ?? null;
  const [phase, setPhase] = useState<"idle" | "transcribing" | "sending">("idle");
  const [notice, setNotice] = useState<string | null>(null);
  // The clip that hit the length cap is sent like a released one.
  const {
    state: mic,
    error: micError,
    start,
    stop,
  } = usePushToTalk({ onCapped: (samples) => void send(samples) });

  async function send(samples: Float32Array | null) {
    if (!samples) {
      setNotice("Hold to talk while you speak");
      return;
    }
    if (!repo) return;
    setPhase("transcribing");
    try {
      const text = await transcribeVoice(samples);
      if (!text) {
        setNotice("Didn't catch that");
        return;
      }
      setPhase("sending");
      await sendVoiceCommand(repo.id, text);
    } catch (cause) {
      setNotice(
        cause instanceof ApiError && cause.status === 409
          ? "Still working on the last command"
          : errorMessage(cause),
      );
    } finally {
      setPhase("idle");
    }
  }

  const disabledReason = !repo
    ? "Pick a repository first"
    : status.data && !status.data.available
      ? (status.data.reason ?? "Voice control is unavailable")
      : null;

  function press() {
    if (mic !== "idle" || phase !== "idle") return;
    // The hotkey gets here even while the button is disabled.
    if (disabledReason !== null) {
      setNotice(disabledReason);
      return;
    }
    setNotice(null);
    void start();
  }

  function release() {
    if (mic === "idle") return;
    void send(stop());
  }

  usePushToTalkHotkey(hotkey, { onPress: press, onRelease: release });
  const hotkeyLabel = hotkey ? voiceHotkeyLabel(hotkey, isMac()) : null;
  const recording = mic !== "idle";
  const busy = recording || phase !== "idle" || !!voice.data?.busy;

  // Whatever the server held when the page loaded counts as seen.
  const key = panelKey(voice.data, notice ?? micError);
  const [seenKey, setSeenKey] = useState<string | null>(null);
  if (seenKey === null && voice.data) setSeenKey(key);
  useEffect(() => {
    if (busy) return;
    const timer = setTimeout(() => setSeenKey(key), PANEL_LINGER_MS);
    return () => clearTimeout(timer);
  }, [busy, key]);
  const showPanel = busy || (seenKey !== null && key !== seenKey);

  return (
    <div className={cn("relative", className)}>
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "touch-none select-none aria-pressed:bg-muted aria-pressed:text-running aria-pressed:[--bw-chamfer-line:var(--st-running)]",
          recording && !prefersReducedMotion() && "animate-pulse-running",
        )}
        aria-label="Hold to talk"
        aria-pressed={recording}
        aria-describedby={showPanel ? "voice-panel" : undefined}
        aria-keyshortcuts={hotkey ? ariaKeyShortcuts(hotkey) : undefined}
        title={
          disabledReason ??
          (hotkeyLabel
            ? `Hold to talk (${hotkeyLabel}, or Space while focused)`
            : "Hold to talk (Space while focused)")
        }
        disabled={disabledReason !== null}
        onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          press();
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key !== " " && event.key !== "Enter") return;
          event.preventDefault();
          if (!event.repeat) press();
        }}
        onKeyUp={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key !== " " && event.key !== "Enter") return;
          event.preventDefault();
          release();
        }}
        onBlur={release}
      >
        <MicIcon />
      </Button>
      {showPanel && (
        <VoicePanel
          voice={voice.data}
          recording={recording}
          phase={phase}
          notice={notice ?? micError}
        />
      )}
    </div>
  );
}

function VoicePanel({
  voice,
  recording,
  phase,
  notice,
}: {
  voice: VoiceState | undefined;
  recording: boolean;
  phase: "idle" | "transcribing" | "sending";
  notice: string | null;
}) {
  const working = phase !== "idle" || !!voice?.busy;
  const created = voice?.created;
  return (
    <div
      id="voice-panel"
      role="status"
      aria-live="polite"
      className="bw-no-drag absolute top-full right-0 z-50 mt-2 w-80 animate-fade-in drop-shadow-pop"
    >
      <div className="bw-chamfer flex flex-col gap-1.5 bg-popover px-3 py-2.5 text-body [--bw-chamfer-line:var(--border-strong)]">
        <span className="label text-muted-foreground">Voice</span>
        {recording ? (
          <span className="text-running">Listening…</span>
        ) : phase === "transcribing" ? (
          <span className="text-muted-foreground">Transcribing…</span>
        ) : (
          voice?.transcript && <span className="text-foreground-strong">“{voice.transcript}”</span>
        )}
        {working && !recording && phase !== "transcribing" && (
          <span className="flex min-w-0 items-center gap-1.5 text-running">
            <SpinnerIcon size="sm" className="animate-spin" />
            <span className="shrink-0">Working…</span>
            {voice?.activity && (
              <span className="mono min-w-0 truncate text-muted-foreground">{voice.activity}</span>
            )}
          </span>
        )}
        {notice ? (
          <span className="text-meta text-destructive">{notice}</span>
        ) : (
          !working &&
          (voice?.error ? (
            <span className="text-meta text-destructive">{voice.error}</span>
          ) : (
            voice?.reply && <span className="text-foreground">{voice.reply}</span>
          ))
        )}
        {created && !working && (
          <span className="text-meta">
            {created.taskId ? (
              <Link to="/tasks/$taskId" params={{ taskId: created.taskId }}>
                Open task
              </Link>
            ) : (
              <Link to="/repos/$repoId/backlog" params={{ repoId: created.repoId }}>
                View backlog
              </Link>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
