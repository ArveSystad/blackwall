import {
  DataArchiveTooNewError,
  DataImportBusyError,
  DataImportDecisionsError,
  InvalidDataArchiveError,
} from "@blackwall/core";
import {
  DATA_IMPORT_TABLES,
  dataImportPreviewSchema,
  dataImportResultSchema,
  type DataImportPreview,
  type DataImportResult,
  type RepoConflict,
} from "@blackwall/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";
import type { DataRouteService } from "./data.js";

const port = 4711;
const host = `127.0.0.1:${port}`;
const ZIP = new Uint8Array([0x50, 0x4b, 5, 6]);

const manifest: DataImportResult["manifest"] = {
  format: 1,
  app: "blackwall",
  blackwallVersion: "0.0.0",
  exportedAt: "2026-10-14T12:00:00.000Z",
  migration: { count: 17, tag: "0016_repo_default_branch", when: 1 },
  includesTranscripts: true,
};

const conflict: RepoConflict = {
  id: "r1",
  name: "app",
  path: "/work/app",
  remoteUrl: "git@github.com:acme/app.git",
  importedId: "r9",
  importedName: "app",
  importedPath: "/code/app",
  importedRemoteUrl: "https://github.com/acme/app",
  kind: "different-path",
};

const preview: DataImportPreview = { manifest, repoConflicts: [conflict] };

const result: DataImportResult = {
  backupPath: "/home/me/.blackwall/backups/blackwall-20261014-120000.db",
  manifest,
  counts: Object.fromEntries(
    DATA_IMPORT_TABLES.map((t) => [t, { imported: 1, skipped: 2 }]),
  ) as DataImportResult["counts"],
  matchedRepos: [],
  repoDecisions: [{ ...conflict, decision: "merge" }],
  connectionsMissingToken: [],
  missingRepos: [{ id: "r1", name: "app", path: "/code/app" }],
  tasksMissingWorktree: [],
};

let data: { [K in keyof DataRouteService]: ReturnType<typeof vi.fn<DataRouteService[K]>> };

beforeEach(() => {
  data = {
    export: vi.fn(() => ZIP),
    import: vi.fn(async () => result),
    preview: vi.fn(() => preview),
  };
});

function request(
  path: string,
  init: { method?: string; body?: Uint8Array; cookie?: boolean } = {},
): Promise<Response> {
  const app = createApp({ token: "test-token", getPort: () => port, data }).app;
  return Promise.resolve(
    app.request(`http://${host}/api/data/${path}`, {
      method: init.method ?? "GET",
      headers: {
        host,
        ...(init.cookie === false ? {} : { cookie: `${tokenCookieName(port)}=test-token` }),
        "content-type": "application/zip",
      },
      ...(init.body ? { body: init.body } : {}),
    }),
  );
}

describe("data routes", () => {
  it("downloads an export as a zip attachment", async () => {
    const res = await request("export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="blackwall-export-\d{8}-\d{6}\.zip"$/,
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ZIP);
    expect(data.export).toHaveBeenCalledWith({ includeTranscripts: true });

    await request("export?transcripts=0");
    expect(data.export).toHaveBeenLastCalledWith({ includeTranscripts: false });
  });

  it("imports the raw body and returns the report", async () => {
    const res = await request("import", { method: "POST", body: ZIP });
    expect(res.status).toBe(200);
    expect(dataImportResultSchema.parse(await res.json())).toEqual(result);
    expect(data.import).toHaveBeenCalledWith(ZIP, {});
  });

  it("previews the repo conflicts of the raw body", async () => {
    const res = await request("import/preview", { method: "POST", body: ZIP });
    expect(res.status).toBe(200);
    expect(dataImportPreviewSchema.parse(await res.json())).toEqual(preview);
    expect(data.preview).toHaveBeenCalledWith(ZIP);
    expect((await request("import/preview", { method: "POST" })).status).toBe(400);
  });

  it("passes the repo decisions from the query", async () => {
    const repos = encodeURIComponent(JSON.stringify({ r9: "merge", r8: "skip" }));
    const res = await request(`import?repos=${repos}`, { method: "POST", body: ZIP });
    expect(res.status).toBe(200);
    expect(data.import).toHaveBeenCalledWith(ZIP, { r9: "merge", r8: "skip" });
  });

  it("rejects malformed repo decisions", async () => {
    for (const repos of ["{nope", JSON.stringify({ r9: "keep" }), JSON.stringify(["r9"])]) {
      const res = await request(`import?repos=${encodeURIComponent(repos)}`, {
        method: "POST",
        body: ZIP,
      });
      expect(res.status, repos).toBe(400);
    }
    expect(data.import).not.toHaveBeenCalled();
  });

  it("maps undecided repo conflicts to 409", async () => {
    data.import.mockRejectedValueOnce(new DataImportDecisionsError([conflict]));
    const res = await request("import", { method: "POST", body: ZIP });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("pick the file again");
  });

  it("maps a busy import to 409 and bad archives to 400", async () => {
    data.import.mockRejectedValueOnce(new DataImportBusyError(["Fix login"]));
    const busy = await request("import", { method: "POST", body: ZIP });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toContain("Fix login");

    data.import.mockRejectedValueOnce(new InvalidDataArchiveError("manifest.json is missing"));
    expect((await request("import", { method: "POST", body: ZIP })).status).toBe(400);

    data.import.mockRejectedValueOnce(new DataArchiveTooNewError());
    expect((await request("import", { method: "POST", body: ZIP })).status).toBe(400);

    expect((await request("import", { method: "POST" })).status).toBe(400);
  });

  it("requires the session cookie", async () => {
    expect((await request("export", { cookie: false })).status).toBe(401);
    expect((await request("import", { method: "POST", body: ZIP, cookie: false })).status).toBe(
      401,
    );
    expect(data.export).not.toHaveBeenCalled();
    expect(data.import).not.toHaveBeenCalled();
  });
});
