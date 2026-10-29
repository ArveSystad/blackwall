import { describe, expect, it } from "vitest";
import {
  githubRepoUrl,
  remoteKey,
  remoteRepoSlug,
  renamedRemoteUrl,
  renamedRepoPath,
} from "./index.js";

describe("remoteKey", () => {
  it("normalises https and scp-like ssh remotes to the same key", () => {
    expect(remoteKey("https://github.com/Acme/App.git")).toBe("github.com/acme/app");
    expect(remoteKey("git@github.com:acme/app")).toBe("github.com/acme/app");
  });

  it("drops ssh:// with a port, credentials, .git and a trailing slash", () => {
    expect(remoteKey("ssh://git@github.com:22/acme/app.git")).toBe("github.com/acme/app");
    expect(remoteKey("https://user:secret@github.com/acme/app")).toBe("github.com/acme/app");
    expect(remoteKey("https://github.com/acme/app.git/")).toBe("github.com/acme/app");
    expect(remoteKey("https://github.com/acme/app/")).toBe("github.com/acme/app");
  });

  it("lower-cases mixed case", () => {
    expect(remoteKey("HTTPS://GitHub.com/ACME/App")).toBe("github.com/acme/app");
  });

  it("maps ssh.github.com to github.com", () => {
    expect(remoteKey("ssh://git@ssh.github.com:443/acme/app.git")).toBe("github.com/acme/app");
  });

  it("keeps a GHE host", () => {
    expect(remoteKey("git@acme.ghe.com:team/app.git")).toBe("acme.ghe.com/team/app");
  });

  it("keeps GitLab subgroups", () => {
    expect(remoteKey("https://gitlab.com/group/sub/app.git")).toBe("gitlab.com/group/sub/app");
    expect(remoteKey("git@gitlab.com:group/sub/app.git")).toBe("gitlab.com/group/sub/app");
  });

  it("returns null for local paths, empty and unparseable input", () => {
    expect(remoteKey(null)).toBeNull();
    expect(remoteKey("")).toBeNull();
    expect(remoteKey("   ")).toBeNull();
    expect(remoteKey("C:\\code\\app")).toBeNull();
    expect(remoteKey("C:/code/app")).toBeNull();
    expect(remoteKey("/srv/git/app.git")).toBeNull();
    expect(remoteKey("file:///srv/git/app.git")).toBeNull();
    expect(remoteKey("not a remote")).toBeNull();
    expect(remoteKey("https://")).toBeNull();
  });
});

describe("remoteRepoSlug", () => {
  it("keeps the original case and drops .git", () => {
    expect(remoteRepoSlug("https://github.com/Acme/App.git")).toEqual({
      host: "github.com",
      owner: "Acme",
      repo: "App",
    });
    expect(remoteRepoSlug("git@acme.ghe.com:team/app")).toEqual({
      host: "acme.ghe.com",
      owner: "team",
      repo: "app",
    });
    expect(remoteRepoSlug("ssh://git@github.com:22/acme/app.git")).toMatchObject({
      owner: "acme",
      repo: "app",
    });
  });

  it("is null for local paths and paths that aren't owner/repo", () => {
    expect(remoteRepoSlug("C:\\code\\app")).toBeNull();
    expect(remoteRepoSlug("/srv/git/app.git")).toBeNull();
    expect(remoteRepoSlug("https://gitlab.com/group/sub/app.git")).toBeNull();
    expect(remoteRepoSlug(null)).toBeNull();
  });
});

describe("renamedRemoteUrl", () => {
  it("swaps only the repo name", () => {
    expect(renamedRemoteUrl("https://github.com/acme/app.git", "shop")).toBe(
      "https://github.com/acme/shop.git",
    );
    expect(renamedRemoteUrl("https://github.com/acme/app", "shop")).toBe(
      "https://github.com/acme/shop",
    );
    expect(renamedRemoteUrl("git@github.com:acme/app.git", "shop")).toBe(
      "git@github.com:acme/shop.git",
    );
    expect(renamedRemoteUrl("ssh://git@github.com:2222/acme/app.git", "shop")).toBe(
      "ssh://git@github.com:2222/acme/shop.git",
    );
    expect(renamedRemoteUrl("https://user:secret@acme.ghe.com/team/app.git", "shop")).toBe(
      "https://user:secret@acme.ghe.com/team/shop.git",
    );
  });

  it("is null for remotes without an owner/repo slug", () => {
    expect(renamedRemoteUrl("C:\\code\\app", "shop")).toBeNull();
  });
});

describe("renamedRepoPath", () => {
  it("swaps the last segment and keeps the separator", () => {
    expect(renamedRepoPath("C:\\code\\app", "shop")).toBe("C:\\code\\shop");
    expect(renamedRepoPath("/home/me/code/app", "shop")).toBe("/home/me/code/shop");
  });
});

describe("githubRepoUrl", () => {
  it("builds the web address", () => {
    expect(githubRepoUrl({ host: "github.com", owner: "acme", repo: "app" }, "shop")).toBe(
      "https://github.com/acme/shop",
    );
  });
});
