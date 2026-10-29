import { describe, expect, it } from "vitest";
import { ROUTE_TRANSITION_TYPE, routeTransitionTypes, routeViewKey } from "./route-transition";

describe("routeViewKey", () => {
  it("is empty for Home", () => {
    expect(routeViewKey("/")).toBe("");
  });

  it("is the first path segment", () => {
    expect(routeViewKey("/tasks/a")).toBe("tasks");
    expect(routeViewKey("/repos/x/backlog")).toBe("repos");
    expect(routeViewKey("/settings/agents")).toBe("settings");
  });
});

describe("routeTransitionTypes", () => {
  it("wipes between top-level views", () => {
    expect(ROUTE_TRANSITION_TYPE).toBe("bw-route");
    expect(routeTransitionTypes("/", "/stats", false)).toEqual(["bw-route"]);
    expect(routeTransitionTypes("/tasks/a", "/settings/connections", false)).toEqual(["bw-route"]);
    expect(routeTransitionTypes("/stats", "/", false)).toEqual(["bw-route"]);
  });

  it("wipes between a grid view and another shell page", () => {
    expect(routeTransitionTypes("/tasks/a", "/reviews", false)).toEqual(["bw-route"]);
    expect(routeTransitionTypes("/active", "/", false)).toEqual(["bw-route"]);
  });

  it("does not wipe between grid views", () => {
    expect(routeTransitionTypes("/", "/repos/x/backlog", false)).toBe(false);
    expect(routeTransitionTypes("/", "/tasks/a", false)).toBe(false);
    expect(routeTransitionTypes("/tasks/a", "/repos/x/backlog", false)).toBe(false);
  });

  it("does not wipe within a view", () => {
    expect(routeTransitionTypes("/tasks/a", "/tasks/b", false)).toBe(false);
    expect(routeTransitionTypes("/settings/connections", "/settings/agents", false)).toBe(false);
    expect(routeTransitionTypes("/repos/x/backlog", "/repos/y/backlog", false)).toBe(false);
  });

  it("does not wipe on a search-only change", () => {
    expect(routeTransitionTypes("/repos/x/backlog", "/repos/x/backlog", false)).toBe(false);
  });

  it("does not wipe on first load", () => {
    expect(routeTransitionTypes(undefined, "/", false)).toBe(false);
  });

  it("does not wipe under reduced motion", () => {
    expect(routeTransitionTypes("/", "/stats", true)).toBe(false);
  });
});
