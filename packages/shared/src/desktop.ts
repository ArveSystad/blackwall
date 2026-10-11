import { z } from "zod";

/**
 * IPC between the desktop shell's Electron main process and the server child
 * it forks (`apps/server/src/desktop-entry.ts`). Messages are `{ type, ...fields }`.
 */
export const desktopChildMessageSchema = z.discriminatedUnion("type", [
  /** The server is listening; the window loads `launchUrl`. */
  z.object({ type: z.literal("ready"), launchUrl: z.string(), port: z.number().int() }),
  /** Startup failed; the child exits 1 after sending this. */
  z.object({ type: z.literal("failed"), message: z.string() }),
  /** Reply to a `status` request. */
  z.object({ type: z.literal("status"), runningAgents: z.number().int().nonnegative() }),
  /** Shutdown finished; the child exits 0 after sending this. */
  z.object({ type: z.literal("stopped") }),
]);
export type DesktopChildMessage = z.infer<typeof desktopChildMessageSchema>;

export const desktopMainMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status") }),
  z.object({ type: z.literal("shutdown") }),
]);
export type DesktopMainMessage = z.infer<typeof desktopMainMessageSchema>;

/** Parses a message from the server child; `null` when it is not one. */
export function parseDesktopChildMessage(value: unknown): DesktopChildMessage | null {
  const result = desktopChildMessageSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Parses a message from the Electron main process; `null` when it is not one. */
export function parseDesktopMainMessage(value: unknown): DesktopMainMessage | null {
  const result = desktopMainMessageSchema.safeParse(value);
  return result.success ? result.data : null;
}
