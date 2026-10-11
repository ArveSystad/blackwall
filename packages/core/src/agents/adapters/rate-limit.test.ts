import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createClaudeParser } from "./claude.js";
import { createCopilotAdapter, createCopilotParser } from "./copilot.js";
import { permissionsFor } from "../permissions.js";
import {
  claudeRateLimitFromEvent,
  claudeRateLimitFromText,
  copilotRateLimitFromText,
  opencodeRateLimitFromText,
} from "./rate-limit.js";
import type { AgentEvent } from "./types.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const now = new Date("2026-10-09T12:00:00Z");

describe("claudeRateLimitFromEvent", () => {
  it("reads a rejected rate_limit_event's reset time (epoch seconds)", () => {
    expect(
      claudeRateLimitFromEvent({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1791477600 },
      }),
    ).toEqual({ resetsAt: new Date(1791477600 * 1000).toISOString() });
  });

  it("ignores usage reports and other lines", () => {
    for (const status of ["allowed", "allowed_warning"]) {
      expect(
        claudeRateLimitFromEvent({
          type: "rate_limit_event",
          rate_limit_info: { status, resetsAt: 1791477600 },
        }),
      ).toBeUndefined();
    }
    expect(claudeRateLimitFromEvent({ type: "system" })).toBeUndefined();
  });

  it("reports a hit without a reset time", () => {
    expect(
      claudeRateLimitFromEvent({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected" },
      }),
    ).toEqual({});
  });
});

describe("claudeRateLimitFromText", () => {
  it("reads the legacy `usage limit reached|<epoch>` message", () => {
    expect(claudeRateLimitFromText("Claude AI usage limit reached|1791477600", now)).toEqual({
      resetsAt: new Date(1791477600 * 1000).toISOString(),
    });
  });

  it("recognises the newer limit messages without parsing their clock time", () => {
    expect(
      claudeRateLimitFromText("You've hit your limit · resets 7pm (Europe/Oslo)", now),
    ).toEqual({});
    expect(claudeRateLimitFromText("5-hour limit reached ∙ resets 3pm", now)).toEqual({});
    expect(
      claudeRateLimitFromText(
        'API Error: 429 {"type":"rate_limit_error"} retry after 90 seconds',
        now,
      ),
    ).toEqual({ resetsAt: new Date(now.getTime() + 90_000).toISOString() });
  });

  it("leaves other failures alone", () => {
    expect(claudeRateLimitFromText("Error: Reached max turns (1)", now)).toBeUndefined();
    expect(claudeRateLimitFromText("No conversation found with session ID", now)).toBeUndefined();
  });
});

describe("copilotRateLimitFromText", () => {
  it("recognises rate limits and exhausted premium requests", () => {
    expect(copilotRateLimitFromText("Error: 429 Too Many Requests", now)).toEqual({});
    expect(
      copilotRateLimitFromText("You have exceeded your premium request allowance", now),
    ).toBeDefined();
    expect(copilotRateLimitFromText("Sorry, you have been rate-limited.", now)).toEqual({});
    expect(copilotRateLimitFromText("quota exceeded for this month", now)).toEqual({});
  });

  it("honours a relative retry time", () => {
    expect(copilotRateLimitFromText("rate limit exceeded. Try again in 2 hours.", now)).toEqual({
      resetsAt: new Date(now.getTime() + 2 * 3_600_000).toISOString(),
    });
    expect(copilotRateLimitFromText("Rate limited, retry after 45m", now)).toEqual({
      resetsAt: new Date(now.getTime() + 45 * 60_000).toISOString(),
    });
  });

  it("leaves other failures alone", () => {
    expect(copilotRateLimitFromText("Error: not authenticated", now)).toBeUndefined();
  });
});

describe("opencodeRateLimitFromText", () => {
  it("recognises provider rate limits and quota errors", () => {
    expect(opencodeRateLimitFromText("AI_APICallError: 429 Too Many Requests", now)).toEqual({});
    expect(opencodeRateLimitFromText("rate_limit_error: Rate limit exceeded", now)).toEqual({});
    expect(opencodeRateLimitFromText("too many requests", now)).toEqual({});
    expect(
      opencodeRateLimitFromText("You exceeded your current quota (insufficient_quota)", now),
    ).toEqual({});
    expect(opencodeRateLimitFromText("Claude AI usage limit reached", now)).toEqual({});
  });

  it("honours a relative retry time", () => {
    expect(opencodeRateLimitFromText("insufficient_quota. Try again in 20 minutes.", now)).toEqual({
      resetsAt: new Date(now.getTime() + 20 * 60_000).toISOString(),
    });
    expect(opencodeRateLimitFromText("429: rate limited, retry after 30 seconds", now)).toEqual({
      resetsAt: new Date(now.getTime() + 30_000).toISOString(),
    });
  });

  it("leaves other failures alone", () => {
    expect(
      opencodeRateLimitFromText("Unexpected server error. Check server logs for details.", now),
    ).toBeUndefined();
    expect(opencodeRateLimitFromText("Session not found", now)).toBeUndefined();
  });
});

describe("adapter rate-limit events", () => {
  it("turns Claude's rejected rate_limit_event into one rate-limit event before the error", () => {
    const parser = createClaudeParser(() => now);
    const events = readFileSync(join(fixtures, "claude", "rate-limited.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => parser.push(line));
    expect(events.map((e) => e.type)).toEqual(["session", "rate-limit", "error"]);
    expect(events[1]).toEqual({
      type: "rate-limit",
      resetsAt: new Date(1791477600 * 1000).toISOString(),
    });
  });

  it("turns Claude's usage-limit result text into a rate-limit event", () => {
    const parser = createClaudeParser(() => now);
    const events = parser.push(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Claude AI usage limit reached|1791477600",
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["rate-limit", "error"]);
  });

  it("turns a Copilot session.error about a rate limit into a rate-limit event", () => {
    const parser = createCopilotParser({ sessionId: "s1", now: () => now });
    const events = [
      { type: "session.error", data: { message: "Rate limit exceeded. Try again in 10 minutes." } },
      { type: "result", sessionId: "s1", exitCode: 1 },
    ].flatMap((line) => parser.push(JSON.stringify(line)));
    expect(events.map((e) => e.type)).toEqual(["session", "rate-limit", "error"]);
    expect(events[1]).toEqual({
      type: "rate-limit",
      resetsAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    });
  });

  it("finds a limit in a failed run's stderr", async () => {
    const adapter = createCopilotAdapter({
      command: process.execPath,
      commandArgs: [join(fixtures, "fake-cli.js"), "limit"],
    });
    const run = adapter.run({
      cwd: process.cwd(),
      prompt: "hi",
      permissions: permissionsFor("copilot", "read-only"),
    });
    const events: AgentEvent[] = [];
    for await (const event of run) events.push(event);
    await expect(run.result).rejects.toThrow(/rate limit/);
    const hit = events.find((e) => e.type === "rate-limit");
    expect(hit).toMatchObject({ type: "rate-limit", resetsAt: expect.any(String) });
  });
});
