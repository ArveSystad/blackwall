import { describe, expect, it } from "vitest";
import { parseStructuredOutput, structuredOutputRepairPrompt } from "./structured-output.js";

const schema = {
  type: "object",
  properties: { sum: { type: "number" }, color: { type: "string" } },
  required: ["sum", "color"],
};

describe("parseStructuredOutput", () => {
  it("reads the last json block", () => {
    const text =
      'Draft:\n```json\n{"sum": 1, "color": "red"}\n```\nFinal:\n```json\n{"sum": 4, "color": "blue"}\n```';
    expect(parseStructuredOutput(text, schema)).toEqual({
      ok: true,
      value: { sum: 4, color: "blue" },
    });
  });

  it("prefers a json block over a later unlabelled one", () => {
    const text = '```json\n{"sum": 4, "color": "blue"}\n```\n\n```\nnot json\n```';
    expect(parseStructuredOutput(text, schema)).toMatchObject({ ok: true });
  });

  it("falls back to an unlabelled block", () => {
    const text = '```\r\n{"sum": 4, "color": "blue"}\r\n```';
    expect(parseStructuredOutput(text, schema)).toMatchObject({ ok: true });
  });

  it("explains a missing block", () => {
    expect(parseStructuredOutput("4, blue", schema)).toEqual({
      ok: false,
      error: expect.stringContaining("no fenced"),
    });
  });

  it("explains invalid JSON", () => {
    expect(parseStructuredOutput("```json\n{sum: 4}\n```", schema)).toEqual({
      ok: false,
      error: expect.stringContaining("not valid JSON"),
    });
  });

  it("explains a schema mismatch", () => {
    const result = parseStructuredOutput('```json\n{"sum": "four"}\n```', schema);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/sum[\s\S]*color|color[\s\S]*sum/);
  });
});

describe("structuredOutputRepairPrompt", () => {
  it("names the problem and asks for only the block", () => {
    const prompt = structuredOutputRepairPrompt("the answer has no fenced ```json code block");
    expect(prompt).toContain("no fenced");
    expect(prompt).toContain("Reply with only a corrected fenced ```json code block");
  });
});
