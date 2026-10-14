import { describe, expect, it } from "vitest";
import { formatBytes, formatUptime } from "./system-info";

describe("formatBytes", () => {
  it("keeps bytes whole and scales by 1024 with one decimal", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
  });
});

describe("formatUptime", () => {
  it("shows the two largest units", () => {
    expect(formatUptime(45.7)).toBe("45s");
    expect(formatUptime(250)).toBe("4m 10s");
    expect(formatUptime(2 * 3600 + 5 * 60 + 9)).toBe("2h 5m");
    expect(formatUptime(3 * 86_400 + 4 * 3600 + 59)).toBe("3d 4h");
  });
});
