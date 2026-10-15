import type { Task } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  prConversationFinding,
  prThreadFinding,
  seenPrCommentUrls,
  type PullRequestFeedbackThread,
} from "./pr-feedback.js";

const PR = "https://github.com/o/r/pull/7";
const task = { id: "task-1" } as Task;

const comment = (id: number, body: string, author = "reviewer") => ({
  url: `${PR}#discussion_r${id}`,
  author,
  body,
});

const thread = (patch: Partial<PullRequestFeedbackThread> = {}): PullRequestFeedbackThread => ({
  path: "src/login.ts",
  line: 12,
  startLine: 10,
  originalLine: 12,
  side: "RIGHT",
  outdated: false,
  url: `${PR}#discussion_r1`,
  diffHunk: "@@ -10,3 +10,3 @@\n-a == b\n+a === b",
  comments: [comment(1, "Compare in constant time\n\nTiming leaks."), comment(2, "Agreed", "lead")],
  ...patch,
});

describe("prThreadFinding", () => {
  it("places a current RIGHT-side thread on its lines, with its new comments' permalinks", () => {
    const finding = prThreadFinding(task, "run-1", 2, thread(), new Set([`${PR}#discussion_r1`]));
    expect(finding).toMatchObject({
      taskId: "task-1",
      runId: "run-1",
      round: 2,
      stepId: null,
      reviewerAgentId: null,
      severity: "high",
      status: "force-fix",
      file: "src/login.ts",
      lineStart: 10,
      lineEnd: 12,
      title: "PR comment: Agreed",
    });
    const { explanation } = finding!;
    expect(explanation).toContain(
      "Earlier in this thread (already handled):\n\n**reviewer**: Compare in constant time",
    );
    expect(explanation).toContain(`**lead**: Agreed\n\nComment: ${PR}#discussion_r2`);
    expect(explanation).not.toContain(`Comment: ${PR}#discussion_r1`);
    expect(explanation).toContain("~~~~diff\n@@ -10,3 +10,3 @@");
    expect(explanation).toMatch(/Address the new review comments/);
  });

  it("titles a new thread with its first comment's first line, cut to 80 characters", () => {
    const long = "x".repeat(100);
    const finding = prThreadFinding(
      task,
      "run-1",
      0,
      thread({ startLine: null, comments: [comment(1, `${long}\nmore`)] }),
      new Set(),
    );
    expect(finding!.title).toBe(`PR comment: ${"x".repeat(79)}…`);
    expect(finding).toMatchObject({ lineStart: 12, lineEnd: 12 });
    expect(finding!.explanation).not.toContain("Earlier in this thread");
  });

  it("names the file of an outdated thread without lines, and says where it was", () => {
    const finding = prThreadFinding(
      task,
      "run-1",
      0,
      thread({ line: null, startLine: null, outdated: true, originalLine: 9 }),
      new Set([`${PR}#discussion_r1`]),
    );
    expect(finding).toMatchObject({ file: "src/login.ts", lineStart: null, lineEnd: null });
    expect(finding!.explanation).toMatch(
      /^Outdated thread \(originally line 9\); the code has changed since\./,
    );
    expect([...seenPrCommentUrls([finding!])]).toEqual([`${PR}#discussion_r2`]);
  });

  it("puts a base-side thread in the explanation, not on lines", () => {
    const finding = prThreadFinding(task, "run-1", 0, thread({ side: "LEFT" }), new Set());
    expect(finding).toMatchObject({ file: "src/login.ts", lineStart: null, lineEnd: null });
    expect(finding!.explanation).toMatch(/^Comment on the removed\/base side, line 10–12\./);
  });

  it("is undefined when every comment was seen, outdated or not", () => {
    const seen = new Set([`${PR}#discussion_r1`, `${PR}#discussion_r2`]);
    expect(prThreadFinding(task, "run-1", 0, thread(), seen)).toBeUndefined();
    expect(
      prThreadFinding(task, "run-1", 0, thread({ line: null, outdated: true }), seen),
    ).toBeUndefined();
  });
});

describe("prConversationFinding", () => {
  const items = [
    { url: `${PR}#issuecomment-5`, author: "lead", body: "Old note" },
    {
      url: `${PR}#pullrequestreview-6`,
      author: "lead",
      body: "Add a test",
      reviewState: "CHANGES_REQUESTED",
    },
  ];

  it("covers only the new items, with their review state", () => {
    const finding = prConversationFinding(
      task,
      "run-1",
      0,
      7,
      items,
      new Set([`${PR}#issuecomment-5`]),
    );
    expect(finding).toMatchObject({
      title: "PR conversation on #7",
      file: null,
      lineStart: null,
      severity: "high",
      status: "force-fix",
    });
    expect(finding!.explanation).toContain(
      `**lead** (CHANGES_REQUESTED): Add a test\n\nComment: ${PR}#pullrequestreview-6`,
    );
    expect(finding!.explanation).not.toContain("Old note");
  });

  it("is undefined when nothing is new", () => {
    const seen = new Set(items.map((i) => i.url));
    expect(prConversationFinding(task, "run-1", 0, 7, items, seen)).toBeUndefined();
  });
});

describe("seenPrCommentUrls", () => {
  it("reads back every permalink the builders record", () => {
    const findings = [
      prThreadFinding(task, "run-1", 0, thread(), new Set())!,
      prConversationFinding(
        task,
        "run-1",
        0,
        7,
        [{ url: `${PR}#issuecomment-5`, author: "lead", body: "Note" }],
        new Set(),
      )!,
      { explanation: "Unrelated: https://example.com/#discussion_r3" },
    ];
    expect([...seenPrCommentUrls(findings)].toSorted()).toEqual([
      `${PR}#discussion_r1`,
      `${PR}#discussion_r2`,
      `${PR}#issuecomment-5`,
    ]);
  });
});
