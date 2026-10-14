import {
  DataArchiveTooNewError,
  DataImportBusyError,
  InvalidDataArchiveError,
} from "@blackwall/core";
import { dataImportResultSchema, type DataImportResult } from "@blackwall/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";
import type { DataRouteService } from "./data.js";

const port = 4711;
const host = `127.0.0.1:${port}`;
const ZIP = new Uint8Array([0x50, 0x4b, 5, 6]);

const result: DataImportResult = {
  backupPath: "/home/me/.blackwall/backups/blackwall-20261014-120000.db",
  manifest: {
    format: 1,
    app: "blackwall",
    blackwallVersion: "0.0.0",
    exportedAt: "2026-10-14T12:00:00.000Z",
    migration: { count: 17, tag: "0016_repo_default_branch", when: 1 },
    includesTranscripts: true,
  },
  connectionsMissingToken: [],
  missingRepos: [{ id: "r1", name: "app", path: "/code/app" }],
  tasksMissingWorktree: [],
};

let data: { [K in keyof DataRouteService]: ReturnType<typeof vi.fn<DataRouteService[K]>> };

beforeEach(() => {
  data = {
    export: vi.fn(() => ZIP),
    import: vi.fn(async () => result),
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
    expect(data.import).toHaveBeenCalledWith(ZIP);
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
