import { newBacklogItemInputSchema } from "@blackwall/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { badRequest, readJson } from "./validation.js";

function echoApp(): Hono {
  const app = new Hono();
  app.post("/", async (c) => c.json({ body: (await readJson(c)) ?? "undefined" }));
  return app;
}

async function echo(body: string): Promise<unknown> {
  const res = await echoApp().request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return ((await res.json()) as { body: unknown }).body;
}

describe("readJson", () => {
  it("returns the parsed JSON body", async () => {
    expect(await echo(JSON.stringify({ title: "x", n: 1 }))).toEqual({ title: "x", n: 1 });
  });

  it("returns undefined for an empty body", async () => {
    expect(await echo("")).toBe("undefined");
  });

  it("returns undefined for malformed JSON", async () => {
    expect(await echo("{not json")).toBe("undefined");
  });
});

describe("badRequest", () => {
  async function respond(issues: { message: string }[]) {
    const app = new Hono();
    app.get("/", (c) => badRequest(c, issues));
    return app.request("/");
  }

  it("joins several issue messages with '; '", async () => {
    const res = await respond([{ message: "a" }, { message: "b" }]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "a; b" });
  });

  it("returns a single message as is", async () => {
    const res = await respond([{ message: "a" }]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "a" });
  });

  it("reports zod issues for a missing body", async () => {
    const app = new Hono();
    app.post("/", async (c) => {
      const input = newBacklogItemInputSchema.safeParse(await readJson(c));
      if (!input.success) return badRequest(c, input.error.issues);
      return c.json({ ok: true });
    });
    const expected = newBacklogItemInputSchema.safeParse(undefined).error?.issues;
    expect(expected?.length).toBeGreaterThan(0);

    const res = await app.request("/", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: expected?.map((issue) => issue.message).join("; "),
    });
  });
});
