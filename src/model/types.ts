import type Anthropic from "@anthropic-ai/sdk";

// The run transcript uses the Anthropic SDK's own message types, so the history we persist is
// exactly what we send back to the API (thinking blocks included, unmodified). The ScriptedModel
// emits the same shapes, so the loop has one code path for both providers.
export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
export type ToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: "object"; [key: string]: unknown };
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelRequest {
  system: string;
  tools: ToolSpec[];
  messages: MessageParam[];
}

export interface ModelTurn {
  /** end_turn | tool_use | max_tokens | refusal | pause_turn | ... (checked before any tool runs) */
  stopReason: string;
  /** Exactly what gets appended to history as the assistant turn. */
  content: ContentBlockParam[];
  toolCalls: ToolCall[];
  text: string;
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
  refusal?: { category: string | null; explanation: string | null };
  /** Set when the server-side refusal fallback served this turn, e.g. "claude-opus-5-5 -> claude-opus-5". */
  fallback?: string;
}

export interface ModelProvider {
  readonly name: string;
  next(request: ModelRequest): Promise<ModelTurn>;
}
