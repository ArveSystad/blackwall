import { dataStamp, type DataService } from "@blackwall/core";
import {
  dataImportDecisionsSchema,
  type DataImportDecisions,
  type DataImportPreview,
  type DataImportResult,
} from "@blackwall/shared";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { badRequest } from "./validation.js";

/** The data service as the routes use it. */
export type DataRouteService = Pick<DataService, "export" | "import" | "preview">;

/** Largest archive `POST /import` and `POST /import/preview` accept. */
export const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

/**
 * Export and import, mounted at `/api/data`. `GET /export` downloads a zip of
 * the database without secrets (`?transcripts=0` leaves agent transcripts out).
 * `POST /import/preview` takes that zip as the raw body and lists the repos
 * that need a merge-or-skip decision. `POST /import` takes it again and merges
 * it into the data in place, with the decisions as `?repos=<JSON>` (imported
 * repo id to `merge` or `skip`); refused (409) while tasks run or while a
 * conflict has no decision.
 */
export function dataRoutes(data: DataRouteService): Hono {
  const routes = new Hono();

  routes.get("/export", (c) => {
    const includeTranscripts = c.req.query("transcripts") !== "0";
    const bytes = data.export({ includeTranscripts });
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="blackwall-export-${dataStamp(new Date())}.zip"`,
      "Cache-Control": "no-store",
    });
  });

  const limit = bodyLimit({
    maxSize: MAX_IMPORT_BYTES,
    onError: (c) => c.json({ error: "The archive is larger than 1 GiB" }, 413),
  });
  const archiveOf = async (c: Context) => new Uint8Array(await c.req.arrayBuffer());
  const noArchive = (c: Context) => c.json({ error: "No archive in the request body" }, 400);

  routes.post("/import/preview", limit, async (c) => {
    const bytes = await archiveOf(c);
    if (bytes.length === 0) return noArchive(c);
    return c.json<DataImportPreview>(data.preview(bytes));
  });

  routes.post("/import", limit, async (c) => {
    const raw = c.req.query("repos");
    let decisions: DataImportDecisions = {};
    if (raw !== undefined) {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return c.json({ error: "repos is not JSON" }, 400);
      }
      const parsed = dataImportDecisionsSchema.safeParse(json);
      if (!parsed.success) return badRequest(c, parsed.error.issues);
      decisions = parsed.data;
    }
    const bytes = await archiveOf(c);
    if (bytes.length === 0) return noArchive(c);
    return c.json<DataImportResult>(await data.import(bytes, decisions));
  });

  return routes;
}
