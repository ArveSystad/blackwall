/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every rectangle is chamfered (.bw-chamfer*); only true circles stay round. Read from disk:
// vitest hands CSS imports to tests as empty strings.
const src = fileURLToPath(new URL(".", import.meta.url));
const sources = readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts"))
  .map((file) => ({ file, text: readFileSync(join(src, file), "utf8") }));
const styles = readFileSync(join(src, "styles.css"), "utf8");

describe("corners", () => {
  it("reads the sources", () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(styles).toContain(".bw-chamfer");
  });

  it("uses no rounded utility other than rounded-full", () => {
    const found = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/\brounded(?!-full\b|-none\b)[-\w[\].]*/g)].map(
        (match) => `${file}: ${match[0]}`,
      ),
    );
    expect(found).toEqual([]);
  });

  it("rounds nothing in the stylesheet but circles", () => {
    const radii = [...styles.matchAll(/border-radius:\s*([^;]+);/g)].map((match) =>
      (match[1] ?? "").trim(),
    );
    expect(radii.length).toBeGreaterThan(0);
    expect(radii.filter((value) => value !== "50%")).toEqual([]);
  });

  it("zeroes every radius token", () => {
    const tokens = [...styles.matchAll(/(--radius[\w-]*):\s*([^;]+);/g)].map(
      ([, name, value]) => `${name}: ${(value ?? "").trim()}`,
    );
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.filter((token) => !token.endsWith(": 0"))).toEqual([]);
  });

  it("draws checkboxes and radios as chamfered controls", () => {
    expect(styles).toMatch(
      /input:is\(\[type="checkbox"\], \[type="radio"\]\) \{[^}]*appearance: none;/,
    );
    expect(styles).not.toContain("accent-color");
    expect(styles.match(/--bw-glyph-check:/g)).toHaveLength(2);
  });
});
