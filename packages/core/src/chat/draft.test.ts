import { describe, expect, it } from "vitest";
import { draftReply, partialJsonString } from "./draft.js";

const prose = (text: string) => draftReply({ text, json: false });

describe("partialJsonString", () => {
  const reply = 'a "b"\nc \\ é done';
  const json = JSON.stringify({ reply, actions: [] }).replace("é", "\\u00e9");

  it("gives a prefix of the final reply at every cut", () => {
    let previous = "";
    for (let end = 0; end <= json.length; end++) {
      const value = partialJsonString(json.slice(0, end), "reply");
      if (value === null) {
        expect(previous).toBe("");
        continue;
      }
      expect(reply.startsWith(value)).toBe(true);
      expect(value.startsWith(previous)).toBe(true);
      previous = value;
    }
    expect(previous).toBe(reply);
  });

  it("drops an escape split across chunks", () => {
    expect(partialJsonString('{"reply":"a\\', "reply")).toBe("a");
    expect(partialJsonString('{"reply":"a\\u00', "reply")).toBe("a");
    expect(partialJsonString('{"reply":"a\\u00e9', "reply")).toBe("aé");
    expect(partialJsonString('{"reply":"a\\"', "reply")).toBe('a"');
  });

  it("is null until the reply starts", () => {
    expect(partialJsonString("", "reply")).toBeNull();
    expect(partialJsonString('{"rep', "reply")).toBeNull();
    expect(partialJsonString('{"reply": ', "reply")).toBeNull();
    expect(partialJsonString('{"reply": "', "reply")).toBe("");
  });

  it("ignores a nested reply key", () => {
    const nested = '{"actions":[{"kind":"x","reply":"nested"}],"reply":"top';
    expect(partialJsonString(nested, "reply")).toBe("top");
    expect(partialJsonString('{"actions":[{"reply":"nested"', "reply")).toBeNull();
    expect(partialJsonString('{"note":"reply","reply":"yes', "reply")).toBe("yes");
  });
});

describe("draftReply", () => {
  it("takes the reply out of structured-output JSON", () => {
    expect(draftReply({ text: '{"reply":"Hel', json: true })).toBe("Hel");
    expect(draftReply({ text: '{"reply":"', json: true })).toBeNull();
    expect(draftReply({ text: "", json: true })).toBeNull();
  });

  it("gives prose without a fence, trimmed", () => {
    expect(prose("  Hello there\n")).toBe("Hello there");
    expect(prose("   ")).toBeNull();
  });

  it("gives the prose before an open json fence without a reply yet", () => {
    expect(prose("Here you go.\n\n```json\n{")).toBe("Here you go.");
    expect(prose("Here you go.\n\n```json")).toBe("Here you go.");
    expect(prose("Here you go.\n\n``")).toBe("Here you go.");
  });

  it("gives a trailing json fence's partial reply", () => {
    expect(prose('Prose.\n\n```json\n{"reply":"The ans')).toBe("The ans");
    expect(prose('Prose.\n\n```json\n{"reply":"Done","actions":[]}\n```')).toBe("Done");
  });

  it("cuts at a non-json code block, even with prose after it", () => {
    expect(prose("Try this:\n\n```ts\nconst a = 1;\n```\n\nThen run it.")).toBe("Try this:");
  });

  it("cuts at an open non-json fence at the end", () => {
    expect(prose("Try this:\n\n```ts\nconst a")).toBe("Try this:");
  });

  it("cuts at an open unlabelled fence at the end", () => {
    expect(prose("Try this:\n\n```\nconst a")).toBe("Try this:");
  });

  it("cuts at an example json block without a reply", () => {
    const example = 'Config looks like:\n\n```json\n{"port": 80}\n```\n\nMore prose.';
    expect(prose(example)).toBe("Config looks like:");
    expect(prose(`${example}\n\n\`\`\`json\n{"reply":"Final`)).toBe("Final");
  });

  it("runs ahead with an example json block holding a reply", () => {
    expect(prose('For example:\n\n```json\n{"reply":"example"}\n```\n\nMore prose.')).toBe(
      "example",
    );
  });

  it("moves from the prose to the block's reply as the answer streams in", () => {
    const intro = "A quote is a passage.";
    const reply = "A quote is a passage or phrase.";
    const text = `${intro}\n\n\`\`\`json\n${JSON.stringify({ reply, actions: [] })}\n\`\`\``;
    for (let end = 1; end <= text.length; end++) {
      const draft = prose(text.slice(0, end));
      expect(draft === null || intro.startsWith(draft) || reply.startsWith(draft)).toBe(true);
    }
    expect(prose(text)).toBe(reply);
  });
});
