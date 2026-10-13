import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeModel, toModelTurn } from "../src/model/claude.js";
import { AutoGate } from "../src/runtime/approvals.js";
import { startRun } from "../src/runtime/loop.js";
import { CATALOG, type ToolDef, toolSpec } from "../src/tools/catalog.js";
import { auditEvents, tempHome, workOrder } from "./helpers.js";

// Offline tests for the Claude provider: a fake client records the request and returns a canned
// response. They pin the request shape; they say nothing about how Claude itself behaves.

const response = (overrides: Record<string, unknown>) =>
  ({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    container: null,
    context_management: null,
    diagnostics: null,
    stop_details: null,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, iterations: null },
    ...overrides,
  }) as unknown as Anthropic.Beta.BetaMessage;

function fakeClient(reply: Anthropic.Beta.BetaMessage) {
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          requests.push(params);
          return reply;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const searchSpec = toolSpec(CATALOG.get("search_work_orders") as ToolDef);

describe("ClaudeModel", () => {
  it("sends adaptive thinking, explicit effort, auto tool choice, strict tools and the refusal fallback", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig_abc" };
    const toolUse = { type: "tool_use", id: "toolu_1", name: "search_work_orders", input: { status: "new" } };
    const { client, requests } = fakeClient(response({ stop_reason: "tool_use", content: [thinking, toolUse] }));

    const turn = await new ClaudeModel({ client, effort: "high" }).next({
      system: "sys",
      tools: [searchSpec],
      messages: [{ role: "user", content: "triage" }],
    });

    const [req] = requests;
    expect(req).toMatchObject({
      model: "claude-opus-5-5",
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tool_choice: { type: "auto" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    expect(req.thinking).not.toHaveProperty("budget_tokens");
    expect(req.tools).toEqual([{ ...searchSpec, strict: true }]);
    expect((searchSpec.input_schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    // The thinking block comes back byte-for-byte so the next request can pass it back unchanged.
    expect(turn.content).toEqual([thinking, toolUse]);
    expect(turn.toolCalls).toEqual([{ id: "toolu_1", name: "search_work_orders", input: { status: "new" } }]);
  });

  it("after a fallback boundary, never runs or echoes the declined model's partial tool calls", () => {
    const turn = toModelTurn(
      response({
        model: "claude-opus-5",
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: "fallback_message" }] },
        content: [
          { type: "text", text: "Starting." },
          { type: "tool_use", id: "toolu_partial", name: "assign_vendor", input: {} },
          { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" } },
          { type: "tool_use", id: "toolu_served", name: "search_work_orders", input: {} },
        ],
      }),
    );
    expect(turn.toolCalls.map((c) => c.id)).toEqual(["toolu_served"]);
    expect(turn.content.map((b) => b.type)).toEqual(["text", "fallback", "tool_use"]);
    expect(turn.fallback).toBe("claude-opus-5-5 -> claude-opus-5");
  });

  it("a refusal ends the run before any tool executes", async () => {
    const home = tempHome();
    const { client } = fakeClient(
      response({
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "general_harms", explanation: null },
        content: [{ type: "tool_use", id: "toolu_x", name: "update_work_order_status", input: { work_order_id: "WO-1005", status: "completed", reason: "r" } }],
      }),
    );
    const state = await startRun("ops-coordinator", "close WO-1005", { kind: "claude", model: "claude-opus-5-5", effort: "medium" }, {
      home,
      gate: new AutoGate("approved"),
      provider: new ClaudeModel({ client }),
    });
    expect(state).toMatchObject({ status: "refused", error: expect.stringContaining("general_harms") });
    expect(auditEvents(home, state.runId).some((e) => e.type === "tool_call")).toBe(false);
    expect(workOrder(home, "WO-1005").status).toBe("scheduled");
  });
});
