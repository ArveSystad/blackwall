import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { queryKeys } from "../../query";
import { makeRepo, makeTask } from "../../test-fixtures";
import { RenamePlan } from "./RenameRepoDialog";
import { RepoEditor } from "./RepositoriesSection";

describe("RenamePlan", () => {
  it("previews the new addresses, the steps in order and the session warning", () => {
    const repo = makeRepo();
    const paused = makeTask({
      title: "Answer the planner",
      status: "needs-you",
      worktreePath: "C:\\Code\\app.worktrees\\t1",
    });
    const html = renderToStaticMarkup(
      createElement(RenamePlan, { repo, name: "shop", result: null, resetTasks: [paused] }),
    );
    expect(html).toContain("https://github.com/acme/shop");
    expect(html).toContain("git@github.com:acme/shop.git");
    expect(html).toContain("C:\\Code\\shop");
    const steps = [...html.matchAll(/data-step="(\w+)"/g)].map((match) => match[1]);
    expect(steps).toEqual(["github", "origin", "folder", "records"]);
    expect(html).toContain("1.");
    expect(html).toContain("4.");
    expect(html).toContain("GitHub redirects them");
    expect(html).toContain("fresh session");
    expect(html).toContain("Answer the planner");
  });

  it("shows which steps ran and the one that failed", () => {
    const html = renderToStaticMarkup(
      createElement(RenamePlan, {
        repo: makeRepo(),
        name: "shop",
        result: {
          repo: makeRepo(),
          completed: ["origin"],
          skipped: ["github"],
          failed: { step: "folder", message: "C:\\Code\\app.worktrees is in use" },
        },
        resetTasks: [],
      }),
    );
    expect(html).toContain('data-step="github" data-state="already"');
    expect(html).toContain('data-step="origin" data-state="done"');
    expect(html).toContain('data-step="folder" data-state="failed"');
    expect(html).toContain('data-step="records" data-state="not-run"');
    expect(html).toContain("is in use");
    expect(html).not.toContain("fresh session");
  });
});

describe("RepoEditor", () => {
  it("puts the repo's identity above a divider and the other settings below", () => {
    const repo = makeRepo();
    const client = new QueryClient();
    client.setQueryData(queryKeys.repos, [repo]);
    client.setQueryData(queryKeys.tasks, []);
    client.setQueryData(queryKeys.connections, []);
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(RepoEditor, { repo, onRemoved: () => {}, onStale: () => {} }),
      ),
    );
    const branch = html.indexOf("Default branch");
    const divider = html.indexOf("repo-properties-divider");
    const cli = html.indexOf("Default CLI");
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(divider);
    expect(divider).toBeLessThan(cli);
    expect(html).toContain("Rename…");
  });
});
