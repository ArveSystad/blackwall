import { z } from "zod";
import { AgentRunError, type AgentEvent, type AgentResult, type AgentRun } from "./types.js";

type JsonSchema = Record<string, unknown>;

/**
 * Prompt contract for CLIs without a JSON-schema flag: the answer must end with
 * a fenced `json` block holding a value that matches the schema.
 */
export function structuredOutputContract(schema: JsonSchema): string {
  return [
    "End your answer with a single fenced ```json code block holding a JSON value that",
    "matches this JSON Schema. Put nothing after the block.",
    "",
    JSON.stringify(schema),
  ].join("\n");
}

/**
 * Prompt body for CLIs with neither a system-prompt nor a JSON-schema flag
 * (Copilot, OpenCode): the role prompt goes first and the structured-output
 * contract last.
 */
export function inlinePrompt({
  prompt,
  systemPrompt,
  jsonSchema,
}: {
  prompt: string;
  systemPrompt?: string;
  jsonSchema?: JsonSchema;
}): string {
  return [
    ...(systemPrompt ? [`<role>\n${systemPrompt}\n</role>`] : []),
    prompt,
    ...(jsonSchema ? [structuredOutputContract(jsonSchema)] : []),
  ].join("\n\n");
}

/** Follow-up prompt asking the agent to fix an invalid JSON block. */
export function structuredOutputRepairPrompt(problem: string): string {
  return [
    `Your answer's JSON block was not valid: ${problem}`,
    "",
    "Reply with only a corrected fenced ```json code block that matches the JSON Schema you were given.",
  ].join("\n");
}

const FENCED_BLOCK = /```([\w-]*)[^\S\r\n]*\r?\n([\s\S]*?)\r?\n?```/g;

export type StructuredParse = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Reads the structured value from an answer: the last fenced `json` block (or,
 * failing that, the last unlabelled one), validated against the JSON Schema.
 */
export function parseStructuredOutput(text: string, schema: JsonSchema): StructuredParse {
  const blocks = [...text.matchAll(FENCED_BLOCK)].map(([, lang = "", body = ""]) => ({
    lang: lang.toLowerCase(),
    body,
  }));
  const block = blocks.findLast((b) => b.lang === "json") ?? blocks.findLast((b) => b.lang === "");
  if (!block) return { ok: false, error: "the answer has no fenced ```json code block" };

  let value: unknown;
  try {
    value = JSON.parse(block.body);
  } catch (error) {
    return { ok: false, error: `the block is not valid JSON (${(error as Error).message})` };
  }
  const parsed = z.fromJSONSchema(schema).safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: `it does not match the schema:\n${z.prettifyError(parsed.error)}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Adds prompt-contract structured output to a run: once `first` succeeds, its
 * text is parsed against the schema. An invalid answer gets one repair turn
 * (`repair` resumes the session with the given prompt); if that is invalid
 * too, the run fails with `invalid-output`. Events of both runs stream through
 * as one run, with a single `result` carrying `structured`. The repair run's
 * `partial` text is not the answer and is not forwarded, so a streamed draft
 * stays at the first answer's.
 */
export function withStructuredOutput(
  first: AgentRun,
  schema: JsonSchema,
  repair: (prompt: string) => AgentRun,
): AgentRun {
  const queue: AgentEvent[] = [];
  let finished = false;
  let wake: (() => void) | undefined;
  const emit = (event: AgentEvent) => {
    queue.push(event);
    wake?.();
  };

  /**
   * Forwards a run's events except its result, then returns that result. A
   * `repair` run's session is already known and its partial text is no answer.
   */
  async function forward(run: AgentRun, repair: boolean): Promise<AgentResult> {
    for await (const event of run) {
      if (event.type === "result") continue;
      if (repair && (event.type === "session" || event.type === "partial")) continue;
      emit(event);
    }
    return run.result;
  }

  const result = (async () => {
    let answer = await forward(first, false);
    let parsed = parseStructuredOutput(answer.text, schema);
    if (!parsed.ok) {
      answer = await forward(repair(structuredOutputRepairPrompt(parsed.error)), true);
      parsed = parseStructuredOutput(answer.text, schema);
    }
    if (!parsed.ok) {
      const message = `The agent did not return valid structured output: ${parsed.error}`;
      emit({ type: "error", message });
      throw new AgentRunError("invalid-output", message, "", 0);
    }
    const final: AgentResult = { ...answer, structured: parsed.value };
    emit({ type: "result", result: final });
    return final;
  })().finally(() => {
    finished = true;
    wake?.();
  });
  // Callers that only iterate must not trigger an unhandled rejection.
  result.catch(() => undefined);

  return {
    result,
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const event = queue.shift();
        if (event) {
          yield event;
          continue;
        }
        if (finished) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
}
