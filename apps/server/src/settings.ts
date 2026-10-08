import type { SettingsService } from "@blackwall/core";
import {
  generalSettingsUpdateSchema,
  tagListInputSchema,
  type GeneralSettings,
} from "@blackwall/shared";
import { Hono, type Context } from "hono";

function body(c: Context): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

function badRequest(c: Context, issues: readonly { message: string }[]) {
  return c.json({ error: issues.map((issue) => issue.message).join("; ") }, 400);
}

/** Finding tags, injected into code reviewer prompts. */
export function tagRoutes(settings: SettingsService): Hono {
  const routes = new Hono();

  routes.get("/", (c) => c.json<string[]>(settings.tags()));

  /** Replaces the whole list; the order is the display order. */
  routes.put("/", async (c) => {
    const input = tagListInputSchema.safeParse(await body(c));
    if (!input.success) return badRequest(c, input.error.issues);
    return c.json<string[]>(settings.setTags(input.data));
  });

  return routes;
}

/** General settings (the concurrency cap per repo). Role defaults live under `/api/agents`. */
export function settingsRoutes(settings: SettingsService): Hono {
  const routes = new Hono();

  routes.get("/", (c) => c.json<GeneralSettings>(settings.general()));

  routes.patch("/", async (c) => {
    const patch = generalSettingsUpdateSchema.safeParse(await body(c));
    if (!patch.success) return badRequest(c, patch.error.issues);
    return c.json<GeneralSettings>(settings.updateGeneral(patch.data));
  });

  return routes;
}
