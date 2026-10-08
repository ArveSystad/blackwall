import { z } from "zod";
import {
  connectionKindSchema,
  findingSchema,
  grillQuestionSchema,
  runSchema,
  stepEventSchema,
  stepSchema,
  taskSchema,
} from "./domain.js";

/** Query parameter carrying the per-launch token in the launch URL. */
export const TOKEN_QUERY_PARAM = "t";

/** Path of the WebSocket endpoint. */
export const WS_PATH = "/ws";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  name: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** HTTP status of a `MissingCredential` error response. */
export const MISSING_CREDENTIAL_STATUS = 409;

/**
 * Error body when an action needs a connection or token that is not configured.
 * The web app turns it into the missing-token modal, then retries the action.
 */
export const missingCredentialSchema = z.object({
  error: z.literal("MissingCredential"),
  kind: connectionKindSchema,
  /** Host the action targets, e.g. `jbf.ghe.com` or `acme.atlassian.net`. */
  host: z.string().min(1),
  /** The host's connection when it exists but has no token; `null` when there is no connection. */
  connectionId: z.string().nullable(),
  message: z.string(),
});
export type MissingCredential = z.infer<typeof missingCredentialSchema>;

/** Every WebSocket message is a JSON envelope `{ type, payload }`, discriminated on `type`. */
function envelope<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ type: z.literal(type), payload });
}

export const clientEventSchema = z.discriminatedUnion("type", [
  envelope("ping", z.object({ id: z.string() })),
]);
export type ClientEvent = z.infer<typeof clientEventSchema>;

export const serverEventSchema = z.discriminatedUnion("type", [
  envelope("pong", z.object({ id: z.string(), serverTime: z.number() })),
  envelope("error", z.object({ message: z.string() })),
  /** A task was created or changed (status, stage, plan, …). */
  envelope("task.upserted", z.object({ task: taskSchema })),
  envelope("task.removed", z.object({ taskId: z.string() })),
  envelope("run.upserted", z.object({ run: runSchema })),
  envelope("step.upserted", z.object({ step: stepSchema })),
  /** A new entry in a step's streamed event log. */
  envelope("step.event", z.object({ event: stepEventSchema })),
  envelope("finding.upserted", z.object({ finding: findingSchema })),
  envelope("grill.upserted", z.object({ question: grillQuestionSchema })),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Parses a raw client message; returns `null` when it is not a valid event. */
export function parseClientEvent(raw: string): ClientEvent | null {
  const result = clientEventSchema.safeParse(parseJson(raw));
  return result.success ? result.data : null;
}

/** Parses a raw server message; returns `null` when it is not a valid event. */
export function parseServerEvent(raw: string): ServerEvent | null {
  const result = serverEventSchema.safeParse(parseJson(raw));
  return result.success ? result.data : null;
}
