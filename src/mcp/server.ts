import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "../domain/store.js";
import { ApprovalStore, QueueGate } from "../runtime/approvals.js";
import { AuditLog } from "../runtime/audit.js";
import { Gateway } from "../runtime/gateway.js";
import { toolbox } from "../runtime/policy.js";
import { loadAgent } from "../runtime/registry.js";
import { newRunId, RunStore, type RunState } from "../runtime/state.js";
import { toolSpec } from "../tools/catalog.js";
import { newId, nowIso, sha256 } from "../util.js";

/**
 * MCP server over stdio. It is another front door to the same Gateway the agent loop uses, so
 * an MCP client (Claude Code, Claude Desktop) gets the same grants, redaction, approvals and audit:
 *
 *   - the server is started *as* one agent (--agent) and lists only that agent's granted tools
 *   - READ/DRAFT results are redacted to the agent's PII scope
 *   - WRITE calls are queued for human approval (we do not rely on the client's own permission
 *     prompt); after approval, the client calls the tool again with the same arguments
 *   - each server process is one audited session (runId "mcp_...") that `agent-gate rollback` can undo
 */
export function createMcpServer(opts: { agentName: string; home: string }): { server: McpServer; runId: string } {
  const agent = loadAgent(opts.agentName);
  const runs = new RunStore(opts.home);
  const now = nowIso();
  const state: RunState = {
    runId: newRunId("mcp"),
    agent: agent.name,
    task: "MCP session (stdio)",
    provider: { kind: "mcp" },
    status: "running",
    createdAt: now,
    updatedAt: now,
    steps: 0,
    system: "",
    tools: [],
    messages: [],
    pendingTurn: null,
    injectionFlags: [],
    drafts: [],
  };
  runs.save(state);
  const audit = new AuditLog(runs.auditFile(state.runId), state.runId);
  audit.append("run_started", {
    agent: agent.name,
    owner: agent.owner,
    risk_tier: agent.risk_tier,
    pii_scope: agent.pii_scope,
    grants: agent.tools,
    provider: "mcp-stdio",
    approvals: "queue",
  });
  const gateway = new Gateway({
    agent,
    state,
    store: new Store(opts.home),
    approvals: new ApprovalStore(opts.home),
    gate: new QueueGate(),
    audit,
  });

  const server = new McpServer({ name: "agent-gate", version: "0.1.0" });
  for (const tool of toolbox(agent).values()) {
    server.registerTool(
      tool.name,
      {
        title: `${tool.name} [${tool.tier.toUpperCase()}]`,
        description: toolSpec(tool).description,
        inputSchema: tool.schema,
        annotations: {
          readOnlyHint: tool.tier === "read",
          destructiveHint: tool.tier === "write",
          idempotentHint: tool.tier !== "write",
          openWorldHint: false,
        },
      },
      async (args) => {
        // A WRITE call's id is derived from its arguments, so calling again after approval finds
        // the same approval record. Identical WRITE calls in one session are therefore idempotent.
        const id =
          tool.tier === "write"
            ? `mcp_${sha256(`${tool.name}|${JSON.stringify(args)}`).slice(0, 16)}`
            : newId("mcp_call");
        const outcome = await gateway.execute({ id, name: tool.name, input: args });
        runs.save(state);
        if (outcome.kind === "pending") {
          const text =
            `Approval required: request ${outcome.approvalId} is queued for a human reviewer ` +
            `(agent-gate approvals approve ${outcome.approvalId}). Nothing has changed yet. ` +
            `After it is approved, call ${tool.name} again with the same arguments.`;
          return { content: [{ type: "text", text }] };
        }
        return { content: [{ type: "text", text: outcome.content }], isError: outcome.isError };
      },
    );
  }
  return { server, runId: state.runId };
}

export async function startStdioServer(agentName: string, home: string): Promise<void> {
  const { server, runId } = createMcpServer({ agentName, home });
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; diagnostics go to stderr only.
  console.error(`agent-gate MCP server ready: agent=${agentName} session=${runId}`);
}
