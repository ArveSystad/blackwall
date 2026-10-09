import {
  createAgentService,
  createRepositories,
  openDatabase,
  type OpenedDatabase,
} from "@blackwall/core";
import { agentSchema, roleDefaultsByCliSchema, type Agent } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";

const launchToken = "test-token";
const port = 4711;
const host = `127.0.0.1:${port}`;
const cookie = `${tokenCookieName(port)}=${launchToken}`;

let opened: OpenedDatabase;
let app: ReturnType<typeof createApp>["app"];

beforeEach(() => {
  opened = openDatabase(":memory:");
  const repositories = createRepositories(opened.db);
  const agents = createAgentService({
    agents: repositories.agents,
    settings: repositories.settings,
    tags: repositories.tags,
    repos: repositories.repos,
    backlogItems: repositories.backlogItems,
  });
  agents.seed();
  app = createApp({ token: launchToken, getPort: () => port, agents }).app;
});

afterEach(() => opened.close());

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`http://${host}${path}`, {
    method: init.method ?? "GET",
    headers: { host, cookie, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function list(): Promise<Agent[]> {
  return agentSchema.array().parse(await (await request("/api/agents")).json());
}

describe("agent routes", () => {
  it("lists the seeded agents and their Copilot twins", async () => {
    const agents = await list();
    expect(agents).toHaveLength(16);
    expect(agents.filter((a) => a.cli === "copilot")).toHaveLength(8);
  });

  it("creates, edits and deletes an agent", async () => {
    const created = await request("/api/agents", {
      method: "POST",
      body: { name: "Docs reviewer", cli: "claude", eligibleStages: ["code-review"] },
    });
    expect(created.status).toBe(201);
    const agent = agentSchema.parse(await created.json());

    const patched = await request(`/api/agents/${agent.id}`, {
      method: "PATCH",
      body: { model: "sonnet", permissionOverrides: { allow: ["Bash(npm test:*)"] } },
    });
    expect(patched.status).toBe(200);
    expect(agentSchema.parse(await patched.json()).model).toBe("sonnet");

    expect((await request(`/api/agents/${agent.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await request(`/api/agents/${agent.id}`)).status).toBe(404);
  });

  it("rejects invalid agents", async () => {
    const bad = await request("/api/agents", { method: "POST", body: { name: "X", cli: "codex" } });
    expect(bad.status).toBe(400);
    const duplicate = await request("/api/agents", {
      method: "POST",
      body: { name: "Planner", cli: "claude" },
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: "An agent named Planner already exists" });
  });

  it("reads and replaces each CLI's role defaults", async () => {
    const defaults = roleDefaultsByCliSchema.parse(
      await (await request("/api/agents/role-defaults")).json(),
    );
    expect(defaults.claude.codeReviewers).toHaveLength(2);
    expect(defaults.copilot.codeReviewers).toHaveLength(2);

    const agents = await list();
    const ux = agents.find((a) => a.name === "UX/design reviewer (Copilot)");
    const put = await request("/api/agents/role-defaults/copilot", {
      method: "PUT",
      body: { ...defaults.copilot, codeReviewers: [ux?.id] },
    });
    expect(put.status).toBe(200);
    const after = roleDefaultsByCliSchema.parse(await put.json());
    expect(after.copilot.codeReviewers).toEqual([ux?.id]);
    expect(after.claude).toEqual(defaults.claude);

    const ineligible = await request("/api/agents/role-defaults/claude", {
      method: "PUT",
      body: { implementer: ux?.id },
    });
    expect(ineligible.status).toBe(400);

    const unknownCli = await request("/api/agents/role-defaults/codex", {
      method: "PUT",
      body: {},
    });
    expect(unknownCli.status).toBe(400);
  });
});
