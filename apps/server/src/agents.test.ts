import {
  createAgentService,
  createRepositories,
  openDatabase,
  type OpenedDatabase,
} from "@blackwall/core";
import { agentSchema, roleAgentsSchema, type Agent } from "@blackwall/shared";
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
    tasks: repositories.tasks,
    backlogItems: repositories.backlogItems,
    transaction: repositories.transaction,
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
  it("lists the seeded agents, without CLI twins", async () => {
    const agents = await list();
    expect(agents).toHaveLength(8);
    expect(agents.some((a) => a.name.endsWith("(Copilot)"))).toBe(false);
  });

  it("creates, edits and deletes an agent", async () => {
    const created = await request("/api/agents", {
      method: "POST",
      body: { name: "Docs reviewer", eligibleStages: ["code-review"] },
    });
    expect(created.status).toBe(201);
    const agent = agentSchema.parse(await created.json());

    const patched = await request(`/api/agents/${agent.id}`, {
      method: "PATCH",
      body: {
        models: { claude: "sonnet" },
        efforts: { claude: "low" },
        permissionOverrides: { claude: { allow: ["Bash(npm test:*)"] } },
      },
    });
    expect(patched.status).toBe(200);
    expect(agentSchema.parse(await patched.json())).toMatchObject({
      models: { claude: "sonnet" },
      efforts: { claude: "low" },
    });

    expect((await request(`/api/agents/${agent.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await request(`/api/agents/${agent.id}`)).status).toBe(404);
  });

  it("rejects invalid agents", async () => {
    const bad = await request("/api/agents", {
      method: "POST",
      body: { name: "X", models: { codex: "o3" } },
    });
    expect(bad.status).toBe(400);
    for (const efforts of [{ claude: "turbo" }, { opencode: "low" }]) {
      const badEffort = await request("/api/agents", {
        method: "POST",
        body: { name: "X", efforts },
      });
      expect(badEffort.status).toBe(400);
    }
    const duplicate = await request("/api/agents", {
      method: "POST",
      body: { name: "Planner" },
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: "An agent named Planner already exists" });
  });

  it("reads and replaces the role defaults", async () => {
    const defaults = roleAgentsSchema.parse(
      await (await request("/api/agents/role-defaults")).json(),
    );
    expect(defaults.codeReviewers).toHaveLength(2);

    const agents = await list();
    const ux = agents.find((a) => a.name === "UX/design reviewer");
    const put = await request("/api/agents/role-defaults", {
      method: "PUT",
      body: { ...defaults, codeReviewers: [ux?.id] },
    });
    expect(put.status).toBe(200);
    expect(roleAgentsSchema.parse(await put.json())).toEqual({
      ...defaults,
      codeReviewers: [ux?.id],
    });

    const ineligible = await request("/api/agents/role-defaults", {
      method: "PUT",
      body: { implementer: ux?.id },
    });
    expect(ineligible.status).toBe(400);
  });
});
