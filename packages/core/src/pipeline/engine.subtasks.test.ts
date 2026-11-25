import type { Task, TaskOrigin } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELIVERY_DONE_EVENT, type DeliveryContext } from "./delivery.js";
import { InvalidGateResponseError } from "./transitions.js";
import {
  closeEngineTest,
  openEngineTest,
  type Call,
  type Harness,
  harness,
  r,
  seedTask,
  settle,
  task,
} from "./engine-harness.js";

beforeEach(openEngineTest);
afterEach(closeEngineTest);

const PLAN = [
  "## Plan",
  "",
  "### Subtasks",
  "",
  "- api: Add the endpoint",
  "- app: Call the endpoint",
  "",
  "### Follow-up tasks",
  "",
  "None.",
].join("\n");

const issueOrigin: TaskOrigin = {
  kind: "github-issue",
  url: "https://github.com/acme/app/issues/7",
  owner: "acme",
  repo: "app",
  number: 7,
  connectionId: null,
};

const prUrl = (repoName: string) => `https://github.com/acme/${repoName}/pull/1`;

/** The planner writes {@link PLAN} for the parent and splits it into one part per repo. */
function splitting(plan = PLAN) {
  return (stage: Call, options: { prompt: string }) => {
    if (stage === "inform" && !options.prompt.includes("## Parent task")) return { text: plan };
    if (stage === "subtasks") {
      const ids = r.repos.list().map((repo) => repo.id);
      return {
        structured: {
          subtasks: ids.map((repoId) => ({
            repoId,
            title: `Change ${r.repos.get(repoId)!.name}`,
            description: `Do the ${r.repos.get(repoId)!.name} part.`,
          })),
        },
      };
    }
    return {};
  };
}

/** A parent in `app` that may split into `api`, waiting at plan approval. */
async function atPlanApproval(h: Harness, patch: Parameters<typeof seedTask>[0] = {}) {
  const api = r.repos.getByPath("/code/api") ?? r.repos.create({ path: "/code/api", name: "api" });
  const seeded = seedTask({ referenceRepoIds: [api.id], ...patch });
  h.engine.enqueue(seeded.id);
  await settle(h.engine);
  expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
  return seeded;
}

async function split(h: Harness, patch: Parameters<typeof seedTask>[0] = {}) {
  const parent = await atPlanApproval(h, patch);
  await h.engine.respond(parent.id, { gate: "plan-approval", decision: "approve" });
  await settle(h.engine);
  return { parent, children: children(parent.id) };
}

const children = (parentId: string) => r.tasks.list().filter((t) => t.parentTaskId === parentId);

/** Approves a subtask's plan, then finishes it, its delivery opening a PR. */
async function finishChild(h: Harness, child: Task) {
  await h.engine.respond(child.id, { gate: "plan-approval", decision: "approve" });
  await settle(h.engine);
  expect(task(child.id)).toMatchObject({ status: "needs-you", gate: "finish" });
  await h.engine.respond(child.id, { gate: "finish", decision: "approve" });
  await settle(h.engine);
  expect(task(child.id).status).toBe("done");
}

/** Records a delivery that opened the subtask's PR. */
const openingPrs = async (ctx: DeliveryContext) => {
  if (ctx.task.parentTaskId !== null) {
    ctx.record({ action: "open-pr", detail: prUrl(r.repos.get(ctx.task.repoId)!.name) });
  }
};

describe("subtasks", () => {
  it("stores the planner's subtasks and splits the task at plan approval", async () => {
    const h = harness(splitting(), { deliver: openingPrs });
    const parent = await atPlanApproval(h);
    const api = r.repos.getByPath("/code/api")!;
    expect(task(parent.id).subtasks).toEqual([
      { repoId: api.id, title: "Change api", description: "Do the api part." },
      { repoId: parent.repoId, title: "Change app", description: "Do the app part." },
    ]);
    const extraction = h.calls.find((c) => c.stage === "subtasks")!.options.prompt;
    expect(extraction).toContain("Follow-ups to propose:");
    const inform = h.calls.find((c) => c.stage === "inform")!.options.prompt;
    expect(inform).toContain("## Subtasks");
    expect(inform).toContain("write `None.` under `### Follow-up tasks`");

    await h.engine.respond(parent.id, { gate: "plan-approval", decision: "approve" });
    expect(task(parent.id)).toMatchObject({ status: "waiting", gate: null, stage: "plan-review" });
    await settle(h.engine);

    const kids = children(parent.id);
    expect(kids).toHaveLength(2);
    const inApp = kids.find((t) => t.repoId === parent.repoId);
    const inApi = kids.find((t) => t.repoId === api.id);
    expect(inApp).toMatchObject({
      title: "Change app",
      freeText: "Do the app part.",
      origin: { kind: "free-text" },
      mode: null,
      repoId: parent.repoId,
      agents: parent.agents,
      referenceRepoIds: [api.id],
      triageMode: parent.triageMode,
      inRepo: false,
      parentTaskId: parent.id,
      subtasks: [],
    });
    expect(inApi).toMatchObject({ repoId: api.id, referenceRepoIds: [parent.repoId] });
    // The subtasks ran on their own, up to their plan approval.
    for (const kid of kids) {
      expect(task(kid.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    }
    const childInform = h.calls.find(
      (c) => c.stage === "inform" && c.options.prompt.includes("Do the api part."),
    )!.options.prompt;
    expect(childInform).toContain("## Parent task");
    expect(childInform).toContain("### Approved plan");
    expect(childInform).toContain("- app: Change app");
    expect(childInform).toContain("propose the follow-ups your description lists");
    expect(childInform).not.toContain("This task may need changes in more than one");
    expect(task(parent.id).status).toBe("waiting");
  });

  it("stores no subtasks without the heading and implements as before", async () => {
    const h = harness(splitting("## Plan\n\n- Just the app."));
    const parent = await atPlanApproval(h);
    expect(task(parent.id).subtasks).toEqual([]);
    expect(h.calls.some((c) => c.stage === "subtasks")).toBe(false);
    await h.engine.respond(parent.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    expect(task(parent.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    expect(children(parent.id)).toEqual([]);
  });

  it("finishes a free-text parent once its last subtask is done", async () => {
    const h = harness(splitting(), { deliver: openingPrs });
    const { parent, children: kids } = await split(h);

    await finishChild(h, kids[0]!);
    expect(task(parent.id).status).toBe("waiting");
    await finishChild(h, kids[1]!);
    expect(task(parent.id)).toMatchObject({ status: "done", gate: null, error: null });
    expect(r.runs.listByTask(parent.id).at(-1)).toMatchObject({ status: "succeeded" });
    expect(r.backlogItems.list()).toEqual([]);
    expect(h.delivered).not.toContain(parent.id);
  });

  it("finishes a parent when the merged-PR sweep finishes its last subtask", async () => {
    const h = harness(splitting(), { deliver: openingPrs });
    const { parent, children: kids } = await split(h);
    await finishChild(h, kids[0]!);
    const last = kids[1]!;
    await h.engine.respond(last.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    const run = r.runs.listByTask(last.id).at(-1)!;
    const step = r.steps.create({ runId: run.id, stage: "summarize", agentId: null });
    r.stepEvents.append(step.id, DELIVERY_DONE_EVENT, {
      action: "open-pr",
      detail: "https://github.com/acme/api/pull/9",
    });

    expect(await h.engine.finishMergedPullRequest("https://github.com/acme/api/pull/9")).toEqual([
      last.id,
    ]);
    expect(task(parent.id).status).toBe("done");
  });

  it("takes a GitHub issue parent to a comment-only finish listing the subtasks' PRs", async () => {
    const h = harness(splitting(), {
      deliver: openingPrs,
      planActions: [{ kind: "issue-comment", url: issueOrigin.url, body: "report" }],
    });
    const { parent, children: kids } = await split(h, { origin: issueOrigin });
    for (const kid of kids) await finishChild(h, kid);

    expect(task(parent.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    expect(task(parent.id).shortSummary).toBe(
      [
        "Solved with these pull requests:",
        "",
        `- api: Change api — ${prUrl("api")}`,
        `- app: Change app — ${prUrl("app")}`,
      ].join("\n"),
    );
    await expect(
      h.engine.respond(parent.id, { gate: "finish", decision: "revise", message: "More" }),
    ).rejects.toThrow(InvalidGateResponseError);

    await h.engine.respond(parent.id, {
      gate: "finish",
      decision: "approve",
      delivery: { actions: ["issue-comment"] },
    });
    expect(task(parent.id)).toMatchObject({ status: "done", deliveryTargets: ["issue-comment"] });
    expect(h.deliveries.at(-1)).toMatchObject({
      task: { id: parent.id },
      confirmation: { actions: ["issue-comment"], squash: false },
    });
  });

  it("re-settles the parent when subtasks are deleted, back to plan approval when none remain", async () => {
    const h = harness(splitting(), { deliver: openingPrs });
    const { parent, children: kids } = await split(h);
    await finishChild(h, kids[0]!);

    await h.engine.delete(kids[1]!.id);
    expect(task(parent.id).status).toBe("done");

    const h2 = harness(splitting(), { deliver: openingPrs });
    const other = await split(h2);
    for (const kid of other.children) await h2.engine.delete(kid.id);
    // Its proposals stay, so approving splits it again.
    expect(task(other.parent.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    expect(task(other.parent.id).subtasks).toHaveLength(2);
  });

  it("detaches the subtasks of a deleted parent and publishes them", async () => {
    const h = harness(splitting());
    const { parent, children: kids } = await split(h);
    const before = h.events.length;
    await h.engine.delete(parent.id);
    for (const kid of kids) {
      expect(task(kid.id).parentTaskId).toBeNull();
      expect(h.events.slice(before)).toContainEqual({
        type: "task.upserted",
        payload: { task: expect.objectContaining({ id: kid.id, parentTaskId: null }) },
      });
    }
  });

  it("settles a waiting parent on recovery", async () => {
    const h = harness(splitting());
    const { parent, children: kids } = await split(h);
    // Finished while the server was down.
    for (const kid of kids) r.tasks.update(kid.id, { status: "done", gate: null });
    expect(task(parent.id).status).toBe("waiting");
    h.engine.recover();
    await settle(h.engine);
    expect(task(parent.id).status).toBe("done");
  });

  it("splits under autopilot, and an autonomous issue parent finishes without posting", async () => {
    const commentOnIssue = vi.fn(async () => ({ url: "https://example.com" }));
    const h = harness(splitting(), {
      autonomous: () => true,
      commentOnIssue,
      planActions: [{ kind: "issue-comment", url: issueOrigin.url, body: "report" }],
    });
    const api = r.repos.create({ path: "/code/api", name: "api" });
    const parent = seedTask({ referenceRepoIds: [api.id], origin: issueOrigin });
    h.engine.enqueue(parent.id);
    await settle(h.engine);

    const kids = children(parent.id);
    expect(kids).toHaveLength(2);
    for (const kid of kids) expect(task(kid.id).status).toBe("done");
    expect(task(parent.id)).toMatchObject({ status: "done", gate: null });
    expect(commentOnIssue).not.toHaveBeenCalled();
    expect(h.deliveries.find((d) => d.task.id === parent.id)).toMatchObject({
      confirmation: { actions: [] },
    });
  });
});
