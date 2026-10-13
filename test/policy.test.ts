import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AutoGate } from "../src/runtime/approvals.js";
import { decide, toolbox } from "../src/runtime/policy.js";
import { loadAgent, loadAgents, validateAgent } from "../src/runtime/registry.js";
import { AGENTS_DIR } from "../src/util.js";
import { auditEvents, makeGateway, tempHome, workOrder } from "./helpers.js";

const triage = loadAgent("maintenance-triage");
const ops = loadAgent("ops-coordinator");

describe("policy engine", () => {
  it("allows granted READ and DRAFT tools", () => {
    expect(decide(triage, "search_work_orders")).toMatchObject({ effect: "allow", tier: "read" });
    expect(decide(triage, "draft_resident_message")).toMatchObject({ effect: "allow", tier: "draft" });
  });

  it("denies tools that exist but are not granted", () => {
    expect(decide(triage, "assign_vendor")).toMatchObject({ effect: "deny", reason: expect.stringContaining("not granted") });
    expect(decide(triage, "get_lease_summary").effect).toBe("deny"); // least privilege: triage never sees leases
  });

  it("denies tools that do not exist", () => {
    expect(decide(ops, "delete_work_order")).toMatchObject({ effect: "deny", reason: expect.stringContaining("unknown tool") });
  });

  it("requires approval for every WRITE tool, even for the high-risk agent that holds the grant", () => {
    expect(decide(ops, "assign_vendor").effect).toBe("require_approval");
    expect(decide(ops, "update_work_order_status").effect).toBe("require_approval");
  });

  it("builds a toolbox containing only granted tools", () => {
    expect([...toolbox(triage).keys()].sort()).toEqual(["draft_resident_message", "get_unit", "search_work_orders"]);
  });
});

describe("enforcement at the tool-execution layer", () => {
  it("an ungranted WRITE never runs and never reaches a reviewer, even one who approves everything", async () => {
    const home = tempHome();
    const { gateway, state, approvals } = makeGateway(home, "maintenance-triage", new AutoGate("approved"));
    const outcome = await gateway.execute({
      id: "toolu_1",
      name: "update_work_order_status",
      input: { work_order_id: "WO-1001", status: "completed", reason: "x" },
    });
    expect(outcome).toMatchObject({ kind: "result", isError: true });
    expect(workOrder(home, "WO-1001").status).toBe("new");
    expect(approvals.list()).toHaveLength(0);
    expect(auditEvents(home, state.runId).map((e) => e.type)).toEqual(["tool_call", "policy_decision", "tool_result"]);
  });

  it("rejects input that does not match the tool schema", async () => {
    const { gateway } = makeGateway(tempHome(), "maintenance-triage", new AutoGate("denied"));
    const outcome = await gateway.execute({ id: "t", name: "get_unit", input: { unit_id: 101, extra: true } });
    expect(outcome).toMatchObject({ isError: true, content: expect.stringContaining("Invalid input") });
  });
});

describe("agent registry", () => {
  const raw = parse(readFileSync(path.join(AGENTS_DIR, "maintenance-triage.yaml"), "utf8"));

  it("loads every agent in agents/", () => {
    expect(loadAgents().map((a) => a.name)).toEqual(["maintenance-triage", "ops-coordinator", "portfolio-digest"]);
  });

  it("refuses a low-risk agent that grants itself a WRITE tool", () => {
    expect(() => validateAgent({ ...raw, tools: [...raw.tools, "assign_vendor"] })).toThrow(/cannot be granted WRITE/);
  });

  it("refuses grants for tools that do not exist", () => {
    expect(() => validateAgent({ ...raw, tools: ["send_email"] })).toThrow(/unknown tool/);
  });

  it("refuses configs with missing or unexpected fields", () => {
    expect(() => validateAgent({ ...raw, owner: undefined })).toThrow();
    expect(() => validateAgent({ ...raw, approval: "skip" })).toThrow();
  });
});
