import type { Context } from "hono";

/** Reads the JSON request body; an empty or malformed body becomes `undefined` so zod reports it. */
export function readJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

/** Responds 400 with the validation issue messages joined by "; ". */
export function badRequest(c: Context, issues: readonly { message: string }[]) {
  return c.json({ error: issues.map((issue) => issue.message).join("; ") }, 400);
}
