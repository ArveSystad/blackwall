import {
  VoiceDownloadBusyError,
  VoiceToolError,
  VoiceUnavailableError,
  type VoiceCommandService,
  type VoiceModelDownloads,
  type VoiceService,
} from "@blackwall/core";
import {
  DEFAULT_VOICE_MODEL,
  MAX_VOICE_SECONDS,
  VOICE_SAMPLE_RATE,
  newBacklogItemInputSchema,
  voiceCommandInputSchema,
  voiceDownloadInputSchema,
  type BacklogItem,
  type VoiceDownload,
  type VoiceState,
  type VoiceStatus,
  type VoiceTranscript,
} from "@blackwall/shared";
import { Hono, type Context } from "hono";
import { BacklogInputError } from "./backlog.js";

/** The voice command service as the routes use it. */
export type VoiceCommandRouteService = Pick<
  VoiceCommandService,
  "state" | "command" | "submitDraft" | "clearDraft"
>;

export interface VoiceRouteOptions {
  /** Speech-to-text; omit and voice reports itself unavailable. */
  voice?: Pick<VoiceService, "status" | "transcribe">;
  /** Voice commands; omit to leave the command and draft routes out. */
  commands?: VoiceCommandRouteService;
  /** Speech model downloads; omit to leave the download routes out. */
  downloads?: Pick<VoiceModelDownloads, "state" | "start">;
}

/** The largest clip, in bytes of 32-bit float samples. */
const MAX_VOICE_BYTES = VOICE_SAMPLE_RATE * MAX_VOICE_SECONDS * 4;

const UNAVAILABLE: VoiceStatus = {
  available: false,
  model: DEFAULT_VOICE_MODEL,
  reason: "Voice control is not set up on this server",
  installed: [],
};

function badRequest(c: Context, error: { issues: { message: string }[] }) {
  return c.json({ error: error.issues.map((i) => i.message).join("; ") }, 400);
}

/**
 * Voice control, mounted at `/api/voice`. The browser posts a clip as raw
 * mono Float32 PCM at {@link VOICE_SAMPLE_RATE} to `/transcribe`, then the
 * transcript to `/commands`, which a CLI turn acts on in the background (202);
 * progress, the reply and the New task draft arrive as `voice.upserted`. The
 * draft's own form submits through `/draft/:id/submit`, the same claim a voice
 * "confirm" takes, so the task is created once. `POST /download` starts
 * installing a speech model in the background (202; 409 while one runs), and
 * its progress arrives as `voice.download`; `GET /download` is the state now.
 */
export function voiceRoutes({ voice, commands, downloads }: VoiceRouteOptions): Hono {
  const routes = new Hono();

  routes.get("/status", async (c) =>
    c.json<VoiceStatus>(voice ? await voice.status() : UNAVAILABLE),
  );

  routes.post("/transcribe", async (c) => {
    const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/octet-stream") {
      return c.json({ error: "Send the audio as application/octet-stream" }, 415);
    }
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength % 4 !== 0) {
      return c.json({ error: "Send mono 32-bit float samples" }, 400);
    }
    if (body.byteLength > MAX_VOICE_BYTES) {
      return c.json({ error: `Clips are at most ${MAX_VOICE_SECONDS} seconds` }, 413);
    }
    if (!voice) return c.json({ error: UNAVAILABLE.reason }, 503);
    try {
      return c.json<VoiceTranscript>({ text: await voice.transcribe(new Float32Array(body)) });
    } catch (error) {
      if (error instanceof VoiceUnavailableError) return c.json({ error: error.message }, 503);
      throw error;
    }
  });

  if (downloads) {
    routes.get("/download", (c) => c.json<VoiceDownload>(downloads.state()));

    routes.post("/download", async (c) => {
      const input = voiceDownloadInputSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!input.success) return badRequest(c, input.error);
      try {
        return c.json<VoiceDownload>(downloads.start(input.data.model), 202);
      } catch (error) {
        if (error instanceof VoiceDownloadBusyError) return c.json({ error: error.message }, 409);
        throw error;
      }
    });
  }

  if (commands) {
    routes.get("/", (c) => c.json<VoiceState>(commands.state()));

    routes.post("/commands", async (c) => {
      const input = voiceCommandInputSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!input.success) return badRequest(c, input.error);
      const { repoId, text, clientId, taskId } = input.data;
      return c.json<VoiceState>(commands.command(repoId, text, { clientId, taskId }), 202);
    });

    /** The draft's form creates its task; 409 when it was already created or closed. */
    routes.post("/draft/:id/submit", async (c) => {
      const input = newBacklogItemInputSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!input.success) return badRequest(c, input.error);
      try {
        return c.json<BacklogItem>(await commands.submitDraft(c.req.param("id"), input.data), 201);
      } catch (error) {
        if (error instanceof BacklogInputError || error instanceof VoiceToolError) {
          return c.json({ error: error.message }, 400);
        }
        throw error;
      }
    });

    routes.delete("/draft/:id", (c) => {
      commands.clearDraft(c.req.param("id"));
      return c.body(null, 204);
    });
  }

  return routes;
}
