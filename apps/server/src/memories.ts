import type { MemoryBackfill, Repositories } from "@blackwall/core";
import {
  memoryInputSchema,
  memoryUpdateSchema,
  type Memory,
  type MemoryBackfillStatus,
  type RepoMemories,
  type ServerEvent,
} from "@blackwall/shared";
import { Hono, type Context } from "hono";
import { badRequest, readJson } from "./validation.js";

export interface MemoryRouteStores {
  memories: Pick<
    Repositories["memories"],
    "get" | "create" | "update" | "delete" | "listByRepo" | "listAwaitingByRepo"
  >;
  repos: Pick<Repositories["repos"], "get">;
  /** Learns notes from the repo's past tasks; omit to leave the backfill routes out. */
  backfill?: Pick<MemoryBackfill, "start" | "status">;
}

/** Empty `files` become null, as in `parseMemories`. */
function filesOrNull(files: string[] | null | undefined): string[] | null {
  return files?.length ? files : null;
}

/**
 * A repo's memories, mounted at `/api/repos/:repoId/memories`, for the user to
 * review in Settings → Repositories. Notes the user adds have no source task,
 * so Summarize never replaces them; edits and pins mark a note edited
 * (`editedAt`), so a later summary never replaces it either. Held notes
 * (`awaitingMerge`) are listed apart and can be edited or deleted before they
 * are released. Every change broadcasts `memories.changed` with the repo id.
 * `/backfill` reports and starts learning notes from the repo's past tasks
 * (202 on start, 409 while a pass runs); clients poll it while one runs.
 */
export function memoryRoutes(
  { memories, repos, backfill }: MemoryRouteStores,
  { broadcast = () => undefined }: { broadcast?: (event: ServerEvent) => void } = {},
): Hono {
  const routes = new Hono();
  const changed = (repoId: string) => broadcast({ type: "memories.changed", payload: { repoId } });

  routes.use("*", async (c, next) => {
    const repoId = c.req.param("repoId") ?? "";
    if (!repos.get(repoId)) return c.json({ error: `Repo ${repoId} not found` }, 404);
    await next();
  });

  routes.get("/", (c) => {
    const repoId = c.req.param("repoId") ?? "";
    return c.json<RepoMemories>({
      memories: memories.listByRepo(repoId),
      awaitingMerge: memories.listAwaitingByRepo(repoId),
    });
  });

  routes.post("/", async (c) => {
    const repoId = c.req.param("repoId") ?? "";
    const input = memoryInputSchema.safeParse(await readJson(c));
    if (!input.success) return badRequest(c, input.error.issues);
    const { kind, text, files } = input.data;
    const memory = memories.create({
      repoId,
      sourceTaskId: null,
      kind,
      text,
      files: filesOrNull(files),
    });
    changed(repoId);
    return c.json<Memory>(memory, 201);
  });

  const noBackfill = (c: Context) => c.json({ error: "Memory backfill is not available" }, 404);

  routes.get("/backfill", (c) => {
    if (!backfill) return noBackfill(c);
    return c.json<MemoryBackfillStatus>(backfill.status(c.req.param("repoId") ?? ""));
  });

  routes.post("/backfill", (c) => {
    if (!backfill) return noBackfill(c);
    return c.json<MemoryBackfillStatus>(backfill.start(c.req.param("repoId") ?? ""), 202);
  });

  /** The repo's memory, or undefined (another repo's memory counts as missing). */
  function memoryOf(c: Context): Memory | undefined {
    const memory = memories.get(c.req.param("id") ?? "");
    return memory?.repoId === c.req.param("repoId") ? memory : undefined;
  }
  const notFound = (c: Context) => c.json({ error: `Memory ${c.req.param("id")} not found` }, 404);

  routes.patch("/:id", async (c) => {
    const memory = memoryOf(c);
    if (!memory) return notFound(c);
    const input = memoryUpdateSchema.safeParse(await readJson(c));
    if (!input.success) return badRequest(c, input.error.issues);
    const { kind, text, files, pinned } = input.data;
    const patch = {
      ...(kind !== undefined ? { kind } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(files !== undefined ? { files: filesOrNull(files) } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
    };
    const updated = memories.update(memory.id, patch, { byUser: true });
    changed(memory.repoId);
    return c.json<Memory>(updated);
  });

  routes.delete("/:id", (c) => {
    const memory = memoryOf(c);
    if (!memory) return notFound(c);
    memories.delete(memory.id);
    changed(memory.repoId);
    return c.body(null, 204);
  });

  return routes;
}
