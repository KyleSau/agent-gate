import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { ApprovalStore } from "../src/runtime/approvals.js";
import { ROOT } from "../src/util.js";
import { tempHome, workOrder } from "./helpers.js";

/** Spawns the real stdio server (src/mcp/stdio.ts) as a child process, the way Claude Code would. */
async function connect(agent: string, home: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(ROOT, "src", "mcp", "stdio.ts"), "--agent", agent],
    env: { ...getDefaultEnvironment(), AGENT_GATE_HOME: home },
    cwd: ROOT,
    stderr: "ignore",
  });
  const client = new Client({ name: "agent-gate-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");

describe("MCP server (stdio)", () => {
  it("starts and lists only the tools granted to the agent, annotated by tier", async () => {
    const client = await connect("maintenance-triage", tempHome());
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["draft_resident_message", "get_unit", "search_work_orders"]);
      const search = tools.find((t) => t.name === "search_work_orders");
      expect(search?.title).toBe("search_work_orders [READ]");
      expect(search?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(search?.inputSchema).toMatchObject({ type: "object", properties: { status: { enum: expect.any(Array) } } });
    } finally {
      await client.close();
    }
  }, 30_000);

  it("redacts READ results and queues WRITE calls for human approval", async () => {
    const home = tempHome();
    const client = await connect("ops-coordinator", home);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(6);
      expect(tools.find((t) => t.name === "assign_vendor")?.annotations).toMatchObject({ destructiveHint: true });

      const unit = text(await client.callTool({ name: "get_unit", arguments: { unit_id: "U-101" } }));
      expect(unit).toContain("[EMAIL]");
      expect(unit).not.toMatch(/avery|sample@|555-0101/i);

      const args = { work_order_id: "WO-1001", vendor_id: "V-01", reason: "active leak" };
      const first = text(await client.callTool({ name: "assign_vendor", arguments: args }));
      expect(first).toMatch(/Approval required/);
      expect(workOrder(home, "WO-1001").vendorId).toBeNull();

      // A human approves out of band; the client repeats the identical call.
      const approvals = new ApprovalStore(home);
      approvals.decide(approvals.list()[0].id, "approved", "test-reviewer");
      const second = text(await client.callTool({ name: "assign_vendor", arguments: args }));
      expect(second).toContain('"status": "applied"');
      expect(workOrder(home, "WO-1001").vendorId).toBe("V-01");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("rejects calls to tools outside the agent's grants", async () => {
    const client = await connect("maintenance-triage", tempHome());
    try {
      const result = await client.callTool({ name: "assign_vendor", arguments: { work_order_id: "WO-1001", vendor_id: "V-01" } });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);
});
