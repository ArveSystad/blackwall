import type { MissingCredential } from "@blackwall/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MissingCredentialError,
  resolveConnection,
  runWithCredential,
  saveCredential,
} from "./api";
import { missingTokenCopy } from "./missing-token";

const missing: MissingCredential = {
  error: "MissingCredential",
  kind: "github",
  host: "jbf.ghe.com",
  connectionId: null,
  message: "No GitHub connection for jbf.ghe.com",
};

const view = {
  id: "c1",
  name: "jbf.ghe.com",
  kind: "github",
  baseUrl: "https://jbf.ghe.com",
  authMeta: {},
  createdAt: "2026-10-08T10:00:00.000Z",
  updatedAt: "2026-10-08T10:00:00.000Z",
  hasToken: true,
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const res of responses) fetchMock.mockResolvedValueOnce(res);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>, call = 0): unknown {
  return JSON.parse(String(fetchMock.mock.calls[call]?.[1]?.body));
}

afterEach(() => vi.unstubAllGlobals());

describe("API errors", () => {
  it("turns a MissingCredential response into MissingCredentialError", async () => {
    stubFetch(json(409, missing));
    const error = await resolveConnection({ kind: "github", remote: "git@jbf.ghe.com:a/b" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MissingCredentialError);
    expect((error as MissingCredentialError).missing).toEqual(missing);
  });
});

describe("runWithCredential", () => {
  it("prompts for the credential and retries the action once it is saved", async () => {
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new MissingCredentialError(missing))
      .mockResolvedValueOnce("done");
    const prompt = vi.fn(() => Promise.resolve(true));

    await expect(runWithCredential(action, prompt)).resolves.toBe("done");
    expect(prompt).toHaveBeenCalledWith(missing);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("rethrows when the prompt is cancelled, and passes other errors through", async () => {
    const cancelled = runWithCredential(
      () => Promise.reject(new MissingCredentialError(missing)),
      () => Promise.resolve(false),
    );
    await expect(cancelled).rejects.toBeInstanceOf(MissingCredentialError);

    const prompt = vi.fn(() => Promise.resolve(true));
    await expect(
      runWithCredential(() => Promise.reject(new Error("boom")), prompt),
    ).rejects.toThrow("boom");
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("saveCredential", () => {
  it("creates a connection for an unconfigured host", async () => {
    const fetchMock = stubFetch(json(201, view));
    await saveCredential(missing, { token: "t0k" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/connections");
    expect(sentBody(fetchMock)).toEqual({
      name: "jbf.ghe.com",
      kind: "github",
      baseUrl: "https://jbf.ghe.com",
      authMeta: {},
      token: "t0k",
    });
  });

  it("sends the email for a new Jira connection", async () => {
    const fetchMock = stubFetch(json(201, { ...view, kind: "jira" }));
    await saveCredential(
      { ...missing, kind: "jira", host: "acme.atlassian.net" },
      { token: "t0k", email: "me@acme.test" },
    );
    expect(sentBody(fetchMock)).toMatchObject({ authMeta: { email: "me@acme.test" } });
  });

  it("stores the token on an existing connection", async () => {
    const fetchMock = stubFetch(json(200, view));
    await saveCredential({ ...missing, connectionId: "c1" }, { token: "t0k" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/connections/c1/token");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(sentBody(fetchMock)).toEqual({ token: "t0k" });
  });

  it("surfaces the server's error message", async () => {
    stubFetch(json(400, { error: "A connection named jbf.ghe.com already exists" }));
    await expect(saveCredential(missing, { token: "t0k" })).rejects.toThrow(
      "A connection named jbf.ghe.com already exists",
    );
  });
});

describe("missingTokenCopy", () => {
  it("describes a GHE.com host with the repo scope and a token link", () => {
    const copy = missingTokenCopy(missing);
    expect(copy).toMatchObject({
      title: "Token needed for jbf.ghe.com",
      hostType: "GitHub Enterprise Cloud",
      scope: "repo",
      needsEmail: false,
    });
    expect(copy.createLink.href).toBe(
      "https://jbf.ghe.com/settings/tokens/new?scopes=repo&description=blackwall",
    );
  });

  it("names a self-hosted GitHub host GitHub Enterprise Server", () => {
    const copy = missingTokenCopy({ ...missing, host: "git.acme.test" });
    expect(copy.hostType).toBe("GitHub Enterprise Server");
  });

  it("asks for the email only when a Jira connection is created", () => {
    const jira = { ...missing, kind: "jira" as const, host: "acme.atlassian.net" };
    expect(missingTokenCopy(jira)).toMatchObject({ hostType: "Jira Cloud", needsEmail: true });
    expect(missingTokenCopy({ ...jira, connectionId: "c1" }).needsEmail).toBe(false);
  });
});
