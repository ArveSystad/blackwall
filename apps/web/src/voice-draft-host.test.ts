import { describe, expect, it, vi } from "vitest";
import { claimVoiceDraftHost, subscribeVoiceDraftHost, voiceDraftHosted } from "./voice-draft-host";

describe("voice draft host", () => {
  it("is hosted while any claim is held", () => {
    expect(voiceDraftHosted()).toBe(false);
    const first = claimVoiceDraftHost();
    expect(voiceDraftHosted()).toBe(true);
    const second = claimVoiceDraftHost();
    first();
    expect(voiceDraftHosted()).toBe(true);
    second();
    expect(voiceDraftHosted()).toBe(false);
  });

  it("releases a claim only once", () => {
    const first = claimVoiceDraftHost();
    const second = claimVoiceDraftHost();
    first();
    first();
    expect(voiceDraftHosted()).toBe(true);
    second();
    expect(voiceDraftHosted()).toBe(false);
  });

  it("notifies listeners on each change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVoiceDraftHost(listener);
    const release = claimVoiceDraftHost();
    expect(listener).toHaveBeenCalledTimes(1);
    release();
    expect(listener).toHaveBeenCalledTimes(2);
    release();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    claimVoiceDraftHost()();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
