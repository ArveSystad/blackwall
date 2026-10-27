import type { DeliveryPlan, Task } from "@blackwall/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { modKeyLabel } from "../../keyboard";
import { makeTask } from "../../test-fixtures";
import { Outbound, Reviewed } from "./FinishPanel";
import type { TaskAction } from "./use-task-action";

const plan: DeliveryPlan = {
  actions: [{ kind: "push-branch", branch: "feature/x", remote: "origin" }],
  squash: null,
  completed: [],
};

function render(task: Task): string {
  const action: TaskAction = { pending: false, error: null, run: vi.fn(), clearError: vi.fn() };
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Outbound, {
        task,
        plan,
        findings: [],
        action,
        loadPicks: () => undefined,
        onPicksChange: () => {},
      }),
    ),
  );
}

/** The `<button …>…</button>` whose text contains `text`. */
function button(html: string, text: string): string {
  const match = [...html.matchAll(/<button[^>]*>.*?<\/button>/g)].find((m) => m[0].includes(text));
  if (!match) throw new Error(`no button with ${text}`);
  return match[0];
}

describe("Outbound", () => {
  it("locks the finish gate while the task is delivering", () => {
    const html = render(makeTask({ status: "needs-you", gate: "finish", delivering: true }));
    const confirm = button(html, "Finishing…");
    expect(confirm).toContain('disabled=""');
    expect(confirm).toContain("animate-spin");
    expect(confirm).not.toContain(modKeyLabel("↵"));
    expect(button(html, "One more fix round")).toContain('disabled=""');
    const checkboxes = html.match(/<input type="checkbox"[^>]*>/g) ?? [];
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const checkbox of checkboxes) expect(checkbox).toContain('disabled=""');
  });

  it("offers the confirm otherwise", () => {
    const html = render(makeTask({ status: "needs-you", gate: "finish", delivering: false }));
    const confirm = button(html, "Confirm and send 1 action");
    expect(confirm).not.toContain('disabled=""');
    expect(confirm).not.toContain("animate-spin");
    expect(confirm).toContain(modKeyLabel("↵"));
  });
});

describe("Reviewed", () => {
  function renderReviewed(task: Task): string {
    const action: TaskAction = { pending: false, error: null, run: vi.fn(), clearError: vi.fn() };
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(Reviewed, { task, action }),
      ),
    );
  }

  it("offers Refresh and the pull request, but no Re-review before a refresh shows new commits", () => {
    const html = renderReviewed(
      makeTask({
        status: "done",
        mode: "review",
        deliveryTargets: ["pr-review"],
        origin: {
          kind: "github-pr",
          url: "https://github.com/acme/web/pull/914",
          owner: "acme",
          repo: "web",
          number: 914,
          connectionId: null,
        },
      }),
    );
    expect(button(html, "Refresh")).not.toContain('disabled=""');
    expect(html).toContain("Open pull request");
    expect(html).toContain('href="https://github.com/acme/web/pull/914"');
    expect(html).not.toContain("Re-review");
  });
});
