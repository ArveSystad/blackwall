import { dataStamp, type DataService } from "@blackwall/core";
import type { DataImportResult } from "@blackwall/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

/** The data service as the routes use it. */
export type DataRouteService = Pick<DataService, "export" | "import">;

/** Largest archive `POST /import` accepts. */
export const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

/**
 * Export and import, mounted at `/api/data`. `GET /export` downloads a zip of
 * the database without secrets (`?transcripts=0` leaves agent transcripts out);
 * `POST /import` takes that zip as the raw body and replaces all data in place,
 * refused (409) while tasks run.
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

  routes.post(
    "/import",
    bodyLimit({
      maxSize: MAX_IMPORT_BYTES,
      onError: (c) => c.json({ error: "The archive is larger than 1 GiB" }, 413),
    }),
    async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.length === 0) return c.json({ error: "No archive in the request body" }, 400);
      return c.json<DataImportResult>(await data.import(bytes));
    },
  );

  return routes;
}
