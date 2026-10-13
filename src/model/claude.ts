import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, ModelProvider, ModelRequest, ModelTurn } from "./types.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Claude via the official SDK. One call = one assistant turn; the loop in src/runtime/loop.ts
 * owns tool execution, so the policy check and approval gate are explicit in our code rather
 * than hidden inside an SDK tool runner.
 */
export class ClaudeModel implements ModelProvider {
  readonly name = "claude";
  readonly model: string;
  readonly effort: Effort;
  private readonly client: Anthropic;
  private readonly maxTokens: number;

  constructor(opts: { model?: string; effort?: Effort; maxTokens?: number; client?: Anthropic } = {}) {
    this.client = opts.client ?? new Anthropic(); // credentials from ANTHROPIC_API_KEY (never hardcoded)
    this.model = opts.model ?? DEFAULT_CLAUDE_MODEL;
    this.effort = opts.effort ?? "medium";
    this.maxTokens = opts.maxTokens ?? 16000; // thinking counts toward max_tokens, so leave headroom
  }

  async next(request: ModelRequest): Promise<ModelTurn> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: request.system,
      // strict: true guarantees schema-valid arguments; we still validate in the gateway.
      tools: request.tools.map((tool) => ({ ...tool, strict: true })),
      tool_choice: { type: "auto" }, // forced tool_choice ("any"/"tool") is a 400 on this model
      thinking: { type: "adaptive" }, // always on for Opus 5.5; budget_tokens is a 400
      output_config: { effort: this.effort }, // set explicitly; the API default is "medium"
      messages: request.messages,
      // Server-side refusal fallback: if a safety classifier declines, the API re-runs the
      // request on Anthropic's recommended fallback model inside the same call.
      betas: [FALLBACK_BETA],
      fallbacks: "default",
    });
    return toModelTurn(response);
  }
}

const PARTIAL_ONLY = new Set(["thinking", "redacted_thinking", "tool_use", "server_tool_use"]);

/** Maps an API response to a ModelTurn. Exported so it can be unit-tested without the network. */
export function toModelTurn(response: Anthropic.Beta.BetaMessage): ModelTurn {
  // After a mid-output fallback, blocks before the last `fallback` block are the declined model's
  // partial output. Per the docs, its thinking/tool_use blocks are not echoed back, and we never
  // execute tool calls from it. Without a fallback (boundary = -1) everything is kept unchanged.
  const boundary = response.content.map((b) => b.type).lastIndexOf("fallback");
  const echoed = response.content.filter((b, i) => i >= boundary || !PARTIAL_ONLY.has(b.type));
  const served = response.content.slice(boundary + 1);

  const toolCalls = served
    .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
  const text = served
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const fallbackBlock = response.content.findLast((b): b is Anthropic.Beta.BetaFallbackBlock => b.type === "fallback");
  const servedByFallback = (response.usage.iterations ?? []).some((it) => it.type === "fallback_message");

  return {
    stopReason: response.stop_reason ?? "unknown",
    // Thinking blocks are appended unchanged; the history is append-only.
    content: echoed as ContentBlockParam[],
    toolCalls,
    text,
    model: response.model,
    usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
    refusal:
      response.stop_reason === "refusal"
        ? { category: response.stop_details?.category ?? null, explanation: response.stop_details?.explanation ?? null }
        : undefined,
    fallback: servedByFallback ? `${fallbackBlock?.from.model ?? "requested model"} -> ${response.model}` : undefined,
  };
}

/** Human-readable message for the SDK's typed errors (no string matching on messages). */
export function describeApiError(err: unknown): string | null {
  if (err instanceof Anthropic.AuthenticationError) return "Claude API authentication failed: check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.RateLimitError) return "Claude API rate limit hit; retry later.";
  if (err instanceof Anthropic.BadRequestError) return `Claude API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  return null;
}
