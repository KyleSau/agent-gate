import type { ContentBlockParam, ModelProvider, ModelRequest, ModelTurn } from "./types.js";

/** One scripted assistant turn: optional text, optional tool calls, optional forced stop reason. */
export interface ScriptTurn {
  text?: string;
  tool_calls?: Array<{ name: string; input: Record<string, unknown> }>;
  /** Simulate an abnormal stop (e.g. "refusal", "max_tokens") to exercise the loop's checks. */
  stop_reason?: string;
}

/**
 * A deterministic stand-in for Claude, used for demos, tests and CI evals (no API key needed).
 *
 * It replays a fixed list of turns and does not read tool results, so it is NOT a model of
 * good agent behavior. What it is good for: proving the runtime's guarantees hold no matter
 * what the model asks for, including a model that has been fully hijacked by prompt injection.
 *
 * It is stateless: the next turn is chosen by counting assistant turns in the transcript, so a
 * resumed run continues exactly where it stopped.
 *
 * Text may contain {{tool_results}}, which expands to every tool result the model has seen.
 * That simulates a worst-case "leaky" model that copies its whole context into its answer.
 */
export class ScriptedModel implements ModelProvider {
  readonly name = "scripted";

  constructor(private readonly turns: ScriptTurn[]) {}

  async next(request: ModelRequest): Promise<ModelTurn> {
    const index = request.messages.filter((m) => m.role === "assistant").length;
    const turn = this.turns[index] ?? { text: "(script exhausted)" };
    const text = (turn.text ?? "").replace("{{tool_results}}", () => seenToolResults(request));
    const toolCalls = (turn.tool_calls ?? []).map((c, i) => ({
      id: `toolu_scripted_${index + 1}_${i + 1}`,
      name: c.name,
      input: c.input,
    }));
    const content: ContentBlockParam[] = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
    ];
    return {
      stopReason: turn.stop_reason ?? (toolCalls.length ? "tool_use" : "end_turn"),
      content,
      toolCalls,
      text,
      model: "scripted",
      refusal: turn.stop_reason === "refusal" ? { category: null, explanation: "scripted refusal" } : undefined,
    };
  }
}

function seenToolResults(request: ModelRequest): string {
  const out: string[] = [];
  for (const message of request.messages) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      if (typeof block.content === "string") out.push(block.content);
      else for (const part of block.content ?? []) if (part.type === "text") out.push(part.text);
    }
  }
  return out.join("\n");
}
