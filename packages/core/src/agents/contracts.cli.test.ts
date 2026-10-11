import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TAGS,
  planAnswersOutputJsonSchema,
  planAnswersOutputSchema,
  planReviewOutputJsonSchema,
  planReviewOutputSchema,
  reviewOutputJsonSchema,
  reviewOutputSchema,
  stagePermissionProfile,
  summaryOutputJsonSchema,
  summaryOutputSchema,
  type AgentCli,
  type Stage,
} from "@blackwall/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClaudeAdapter } from "./adapters/claude.js";
import { createCopilotAdapter } from "./adapters/copilot.js";
import { createOpencodeAdapter } from "./adapters/opencode.js";
import type { AgentResult } from "./adapters/types.js";
import { permissionsFor } from "./permissions.js";
import { buildSystemPrompt, missingPlanSections } from "./prompts.js";
import { SEED_AGENTS } from "./seeds.js";

/*
 * Runs every seeded persona on all three real CLIs against a throwaway sample
 * repo and checks each output contract (plan, questions, answers, findings,
 * summary) comes back parseable. Needs all three CLIs installed and logged in,
 * and spends real model calls, so it only runs with BLACKWALL_TEST_CLIS=1. Set
 * BLACKWALL_OPENCODE_COMMAND where `opencode` itself cannot be spawned.
 */

const TIMEOUT_MS = 10 * 60_000;

const TASK =
  "# Task\n\nAdd a `subtract(a, b)` function to `src/math.js`, exported next to `add`, with a test.";

const PLAN = [
  "## Goal",
  "Add `subtract(a, b)` to `src/math.js` so callers can subtract numbers.",
  "## Approach",
  "Mirror `add`: a plain exported function.",
  "## Changes",
  "- `src/math.js`: add and export `subtract`.",
  "- `test/math.test.js`: add a test for `subtract`.",
  "## Risks",
  "None known.",
  "## Verification",
  "Run `node --test`.",
].join("\n\n");

const DIFF = [
  "~~~~",
  "diff --git a/src/math.js b/src/math.js",
  "--- a/src/math.js",
  "+++ b/src/math.js",
  "@@ -1,3 +1,7 @@",
  " export function add(a, b) {",
  "   return a + b;",
  " }",
  "+",
  "+export function subtract(a, b) {",
  "+  return b - a;",
  "+}",
  "~~~~",
].join("\n");

let repo: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "blackwall-contracts-")));
  execFileSync("git", ["init", "--quiet", repo]);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "package.json"), '{ "name": "sample", "type": "module" }\n');
  writeFileSync(join(repo, "src", "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  writeFileSync(
    join(repo, "test", "math.test.js"),
    'import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/math.js";\n\ntest("add", () => assert.equal(add(1, 2), 3));\n',
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "init");
  writeFileSync(
    join(repo, "src", "math.js"),
    "export function add(a, b) {\n  return a + b;\n}\n\nexport function subtract(a, b) {\n  return b - a;\n}\n",
  );
  git("commit", "--quiet", "-am", "Add subtract");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

function persona(name: (typeof SEED_AGENTS)[number]["name"]) {
  const seed = SEED_AGENTS.find((a) => a.name === name);
  if (!seed) throw new Error(`No seed ${name}`);
  return seed;
}

function run(
  cli: AgentCli,
  name: (typeof SEED_AGENTS)[number]["name"],
  stage: Stage,
  prompt: string,
  jsonSchema?: Record<string, unknown>,
): Promise<AgentResult> {
  const profile = stagePermissionProfile(stage);
  const adapter =
    cli === "claude"
      ? createClaudeAdapter()
      : cli === "copilot"
        ? createCopilotAdapter()
        : createOpencodeAdapter({ command: process.env.BLACKWALL_OPENCODE_COMMAND ?? "opencode" });
  return adapter.run({
    cwd: repo,
    prompt,
    systemPrompt: buildSystemPrompt({ agent: persona(name), stage, profile, tags: DEFAULT_TAGS }),
    permissions: permissionsFor(cli, profile),
    ...(jsonSchema ? { jsonSchema } : {}),
  }).result;
}

describe.runIf(process.env.BLACKWALL_TEST_CLIS === "1")("seed prompt output contracts", () => {
  for (const cli of ["claude", "copilot", "opencode"] as const) {
    describe.concurrent(cli, () => {
      it(
        "planner writes a plan in the plan contract",
        async () => {
          const result = await run(
            cli,
            "Planner",
            "inform",
            `${TASK}\n\nRead the repository and write a concrete implementation plan in markdown.`,
          );
          expect(missingPlanSections(result.text)).toEqual([]);
        },
        TIMEOUT_MS,
      );

      it(
        "plan reviewer asks questions in the questions contract",
        async () => {
          const result = await run(
            cli,
            "Plan reviewer",
            "plan-review",
            `${TASK}\n\n## Plan\n\n${PLAN}\n\nGrill this plan against the repository.`,
            planReviewOutputJsonSchema(),
          );
          expect(planReviewOutputSchema.safeParse(result.structured).success).toBe(true);
        },
        TIMEOUT_MS,
      );

      it(
        "planner answers questions in the questions contract",
        async () => {
          const result = await run(
            cli,
            "Planner",
            "plan-review",
            `${TASK}\n\n## Plan\n\n${PLAN}\n\n## Reviewers' questions\n\n1. Which test runner does the repository use?\n2. Should subtract also accept strings? (for the user)\n\nAnswer each question not marked (for the user) by its number, then revise the plan.`,
            planAnswersOutputJsonSchema(),
          );
          const parsed = planAnswersOutputSchema.safeParse(result.structured);
          expect(parsed.success).toBe(true);
          expect(missingPlanSections(parsed.data!.plan)).toEqual([]);
        },
        TIMEOUT_MS,
      );

      it(
        "code reviewer reports findings in the findings contract",
        async () => {
          const result = await run(
            cli,
            "Code-quality reviewer",
            "code-review",
            `${TASK}\n\n## Plan\n\n${PLAN}\n\n## Changes to review\n\n${DIFF}\n\nReview the changes above (\`git diff HEAD~1 HEAD\`).`,
            reviewOutputJsonSchema(),
          );
          const parsed = reviewOutputSchema.safeParse(result.structured);
          expect(parsed.success).toBe(true);
          expect(parsed.data!.findings.length).toBeGreaterThan(0);
        },
        TIMEOUT_MS,
      );

      it(
        "summarizer writes a summary, short summary and commit message",
        async () => {
          const result = await run(
            cli,
            "Summarizer",
            "summarize",
            `${TASK}\n\n## Plan\n\n${PLAN}\n\nSummarize the changes on this branch, write a one-sentence \`shortSummary\` of the change for the pull request and write one commit message for squashing it.\nReply with a JSON object \`{ "summary": "<markdown>", "commitMessage": "<message>", "shortSummary": "<markdown>" }\`.`,
            summaryOutputJsonSchema(),
          );
          expect(summaryOutputSchema.safeParse(result.structured).success).toBe(true);
        },
        TIMEOUT_MS,
      );
    });
  }
});
