import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Store } from "../src/domain/store.js";
import { AutoGate, QueueGate } from "../src/runtime/approvals.js";
import { type AuditEvent, AuditLog } from "../src/runtime/audit.js";
import { resumeRun, startRun } from "../src/runtime/loop.js";
import { RunStore } from "../src/runtime/state.js";
import { auditEvents, scripted, tempHome, workOrder } from "./helpers.js";

/** Simulates the process dying at a given audit event: the exception escapes the run mid-step. */
const crashAt = (type: string, nth = 1) => {
  let seen = 0;
  return (e: AuditEvent) => {
    if (e.type === type && ++seen === nth) throw new Error("simulated crash");
  };
};

describe("durable run state", () => {
  it("checkpoints every step, and a resumed run continues without repeating completed tool calls", async () => {
    const home = tempHome();
    const script = scripted([
      { tool_calls: [{ name: "search_work_orders", input: { status: "new" } }] },
      { tool_calls: [{ name: "get_unit", input: { unit_id: "U-101" } }] },
      { text: "done" },
    ]);
    await expect(
      startRun("maintenance-triage", "triage", script, { home, gate: new QueueGate(), onEvent: crashAt("model_request", 2) }),
    ).rejects.toThrow("simulated crash");

    const runs = new RunStore(home);
    const [crashed] = runs.list();
    expect(crashed).toMatchObject({ status: "running", steps: 1 });
    expect(crashed.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]); // checkpoint survived

    const done = await resumeRun(crashed.runId, { home, gate: new QueueGate() });
    expect(done.status).toBe("completed");
    const executed = auditEvents(home, done.runId).filter((e) => e.type === "tool_result").map((e) => e.data.tool);
    expect(executed).toEqual(["search_work_orders", "get_unit"]); // each ran exactly once
  });

  it("a crash after a WRITE commits but before its result is checkpointed does not apply it twice", async () => {
    const home = tempHome();
    const script = scripted([
      { tool_calls: [{ name: "update_work_order_status", input: { work_order_id: "WO-1003", status: "scheduled", reason: "r" } }] },
      { text: "done" },
    ]);
    await expect(
      startRun("ops-coordinator", "schedule", script, { home, gate: new AutoGate("approved"), onEvent: crashAt("write_applied") }),
    ).rejects.toThrow("simulated crash");
    const [crashed] = new RunStore(home).list();
    expect(crashed.pendingTurn?.results).toEqual([]); // the result never made it to the checkpoint

    const done = await resumeRun(crashed.runId, { home, gate: new AutoGate("approved") });
    expect(done.status).toBe("completed");
    expect(new Store(home).load().journal).toHaveLength(1);
    expect(workOrder(home, "WO-1003").status).toBe("scheduled");
    const writes = auditEvents(home, done.runId).filter((e) => e.type === "write_applied");
    expect(writes.at(-1)?.data.recovered).toBe(true);
  });

  it("a completed run cannot be resumed", async () => {
    const home = tempHome();
    const state = await startRun("maintenance-triage", "t", scripted([{ text: "ok" }]), { home, gate: new QueueGate() });
    await expect(resumeRun(state.runId, { home, gate: new QueueGate() })).rejects.toThrow(/nothing to resume/);
  });

  it("rejects run ids that could escape the state directory", () => {
    expect(() => new RunStore(tempHome()).load("../../etc")).toThrow(/invalid run id/);
  });
});

describe("audit log", () => {
  it("is hash-chained, so editing any line is detected", async () => {
    const home = tempHome();
    const state = await startRun("maintenance-triage", "t", scripted([{ text: "ok" }]), { home, gate: new QueueGate() });
    const file = new RunStore(home).auditFile(state.runId);
    expect(AuditLog.verify(AuditLog.read(file))).toBeNull();

    const lines = readFileSync(file, "utf8").trim().split("\n");
    const tampered = JSON.parse(lines[0]);
    tampered.data.task = "something else";
    lines[0] = JSON.stringify(tampered);
    writeFileSync(file, `${lines.join("\n")}\n`);
    expect(AuditLog.verify(AuditLog.read(file))).toBe(1);
  });
});
