import { describe, expect, it } from "vitest";
import { remoteKey } from "./index.js";

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
