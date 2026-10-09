/** A usage limit a CLI reported. `resetsAt` is ISO; absent when the CLI gave no reset time. */
export interface RateLimitHit {
  resetsAt?: string;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Epoch seconds (or milliseconds) to ISO, or undefined when not a plausible time. */
function epochToIso(value: unknown): string | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined;
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

const UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  second: 1000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
};

/** "try again in 2 hours", "retry after 30 seconds", "resets in 45m" → ISO, relative to `now`. */
function relativeReset(text: string, now: Date): string | undefined {
  const match =
    /(?:try again|retry|resets?|available again)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/i.exec(
      text,
    );
  if (!match) return undefined;
  const unit = match[2]!.toLowerCase();
  const ms = UNIT_MS[unit] ?? UNIT_MS[unit.replace(/s$/, "")];
  if (ms === undefined) return undefined;
  return new Date(now.getTime() + Number(match[1]) * ms).toISOString();
}

/**
 * Claude Code's stream-json `rate_limit_event` line. Only a `rejected` status
 * is a hit; `allowed` and `allowed_warning` are usage reports. `resetsAt` is
 * epoch seconds.
 */
export function claudeRateLimitFromEvent(line: unknown): RateLimitHit | undefined {
  if (!isObject(line) || line.type !== "rate_limit_event") return undefined;
  const info = line.rate_limit_info;
  if (!isObject(info) || info.status !== "rejected") return undefined;
  const resetsAt = epochToIso(info.resetsAt);
  return resetsAt ? { resetsAt } : {};
}

/**
 * Claude Code's usage-limit text, from a result error or stderr. Older
 * versions print `Claude AI usage limit reached|<epoch seconds>`; newer ones
 * say "You've hit your limit · resets 3pm" or "5-hour limit reached", whose
 * clock time we do not parse (the caller backs off instead).
 */
export function claudeRateLimitFromText(text: string, now = new Date()): RateLimitHit | undefined {
  const legacy = /usage limit reached\|(\d{9,13})/i.exec(text);
  if (legacy) {
    const resetsAt = epochToIso(legacy[1]);
    return resetsAt ? { resetsAt } : {};
  }
  if (
    !/usage limit reached|hit your (?:usage )?limit|(?:5-hour|weekly|session|opus) limit reached|rate_limit_error|rate limit(?:ed| exceeded)/i.test(
      text,
    )
  ) {
    return undefined;
  }
  const resetsAt = relativeReset(text, now);
  return resetsAt ? { resetsAt } : {};
}

/**
 * GitHub Copilot CLI's limit errors, from `session.error` or stderr: rate
 * limits (HTTP 429), exhausted premium requests and quota errors. Written
 * against GitHub's documented messages, not captured CLI output; a relative
 * "try again in …" is honoured, otherwise the caller backs off.
 */
export function copilotRateLimitFromText(text: string, now = new Date()): RateLimitHit | undefined {
  if (
    !/rate.?limit|too many requests|\b429\b|quota (?:exceeded|exhausted|reached)|exceeded your (?:copilot )?(?:quota|premium request)|premium requests? (?:limit|allowance|quota)|out of premium requests|usage limit/i.test(
      text,
    )
  ) {
    return undefined;
  }
  const resetsAt = relativeReset(text, now);
  return resetsAt ? { resetsAt } : {};
}
