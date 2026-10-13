import { readFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_CLAUDE_MODEL, FALLBACK_BETA } from "../src/model/claude.js";
import type { WorkOrder } from "../src/domain/types.js";
import { ROOT } from "../src/util.js";

/**
 * Optional LLM-as-judge for drafted resident messages, scored against evals/rubrics/draft-message.md.
 * Runs only when ANTHROPIC_API_KEY is set; otherwise the eval report says it was skipped.
 * The deterministic rule checks in assertions.ts always run; the judge covers what rules can't
 * (tone, clarity, whether the message actually answers the resident's request).
 */
export const CRITERIA = ["accuracy", "clarity", "tone", "privacy", "no_overpromising"] as const;

export interface JudgeVerdict {
  draftId: string;
  pass: boolean;
  scores: Record<string, number>;
  rationale: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    ...Object.fromEntries(CRITERIA.map((c) => [c, { type: "integer", description: "1 (poor) to 5 (excellent)" }])),
    rationale: { type: "string" },
  },
  required: [...CRITERIA, "rationale"],
  additionalProperties: false,
};

export const judgeAvailable = () => Boolean(process.env.ANTHROPIC_API_KEY);

export async function judgeDraft(
  draft: { draft_id: string; subject: string; body: string },
  workOrder: WorkOrder,
  client = new Anthropic(),
): Promise<JudgeVerdict> {
  const rubric = readFileSync(path.join(ROOT, "evals", "rubrics", "draft-message.md"), "utf8");
  const response = await client.beta.messages.create({
    model: process.env.AGENT_GATE_JUDGE_MODEL ?? DEFAULT_CLAUDE_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: rubric,
    messages: [
      {
        role: "user",
        content:
          `Score this draft against the rubric.\n\n` +
          `<work_order id="${workOrder.id}" category="${workOrder.category}">\n` +
          `<resident_description untrusted="true">${workOrder.description}</resident_description>\n</work_order>\n\n` +
          `<draft>\nSubject: ${draft.subject}\n\n${draft.body}\n</draft>`,
      },
    ],
    betas: [FALLBACK_BETA],
    fallbacks: "default",
  });
  if (response.stop_reason !== "end_turn") {
    return { draftId: draft.draft_id, pass: false, scores: {}, rationale: `judge stopped with ${response.stop_reason}` };
  }
  const text = response.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text ?? "{}";
  const parsed = JSON.parse(text) as Record<string, number | string>;
  const scores = Object.fromEntries(CRITERIA.map((c) => [c, Number(parsed[c])]));
  const values = Object.values(scores);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    draftId: draft.draft_id,
    pass: values.every((v) => v >= 3) && mean >= 4,
    scores,
    rationale: String(parsed.rationale ?? ""),
  };
}
