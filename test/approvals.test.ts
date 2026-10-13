import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { Store } from "../src/domain/store.js";
import { type ApprovalRecord, ApprovalStore, AutoGate, InteractiveGate, QueueGate } from "../src/runtime/approvals.js";
import { resumeRun, startRun } from "../src/runtime/loop.js";
import { scripted, tempHome, workOrder } from "./helpers.js";

const assignV01 = scripted([
  { tool_calls: [{ name: "assign_vendor", input: { work_order_id: "WO-1001", vendor_id: "V-01", reason: "leak" } }] },
  { text: "done" },
]);

describe("approval gate", () => {
  it("queue mode persists a pending approval and pauses; approving resumes the run and applies the write", async () => {
    const home = tempHome();
    const paused = await startRun("ops-coordinator", "assign a vendor", assignV01, { home, gate: new QueueGate() });
    expect(paused.status).toBe("awaiting_approval");

    const approvals = new ApprovalStore(home);
    const [pending] = approvals.list();
    expect(pending).toMatchObject({ status: "pending", tool: "assign_vendor", runId: paused.runId });
    expect(pending.change.summary).toBe("WO-1001 vendor: none -> V-01 (Northside Plumbing Co.)");
    expect(workOrder(home, "WO-1001").vendorId).toBeNull(); // nothing happens before the decision

    approvals.decide(pending.id, "approved", "test-reviewer");
    const done = await resumeRun(paused.runId, { home, gate: new QueueGate() });
    expect(done.status).toBe("completed");
    expect(workOrder(home, "WO-1001").vendorId).toBe("V-01");
    expect(new Store(home).load().journal).toMatchObject([{ approvalId: pending.id, workOrderId: "WO-1001" }]);
  });

  it("a denial reaches the model as an is_error tool result and changes nothing", async () => {
    const home = tempHome();
    const state = await startRun("ops-coordinator", "assign a vendor", assignV01, { home, gate: new AutoGate("denied") });
    expect(state.status).toBe("completed");
    const results = state.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(results).toContainEqual(
      expect.objectContaining({ type: "tool_result", is_error: true, content: expect.stringContaining("Denied by human reviewer") }),
    );
    expect(workOrder(home, "WO-1001").vendorId).toBeNull();
  });

  it("decisions are final", async () => {
    const home = tempHome();
    await startRun("ops-coordinator", "assign", assignV01, { home, gate: new QueueGate() });
    const approvals = new ApprovalStore(home);
    const [pending] = approvals.list();
    approvals.decide(pending.id, "denied", "a");
    expect(() => approvals.decide(pending.id, "approved", "b")).toThrow(/already denied/);
  });

  it("refuses a stale approval when the record changed after the approval was requested", async () => {
    const home = tempHome();
    const paused = await startRun("ops-coordinator", "assign", assignV01, { home, gate: new QueueGate() });
    new Store(home).commit((db) => {
      const wo = db.workOrders.find((w) => w.id === "WO-1001");
      if (wo) wo.vendorId = "V-04"; // someone else assigned a vendor meanwhile
    });
    const approvals = new ApprovalStore(home);
    approvals.decide(approvals.list()[0].id, "approved", "reviewer");
    const done = await resumeRun(paused.runId, { home, gate: new QueueGate() });
    const results = done.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(results).toContainEqual(expect.objectContaining({ is_error: true, content: expect.stringContaining("Stale approval") }));
    expect(workOrder(home, "WO-1001").vendorId).toBe("V-04");
  });
});

describe("interactive gate", () => {
  const rec = { id: "apr_1", runId: "run_1", agent: "ops-coordinator", tool: "assign_vendor", warnings: ["injection seen"],
    change: { workOrderId: "WO-1001", before: {}, after: {}, summary: "WO-1001 vendor: none -> V-01" }, input: {} } as unknown as ApprovalRecord;
  const ask = (answer: string[]) => new InteractiveGate(Readable.from(answer), new PassThrough(), "kyle").decide(rec);

  it("approves only on an explicit yes", async () => {
    expect((await ask(["y\n"])).status).toBe("approved");
    expect((await ask(["yes\n"])).status).toBe("approved");
    expect((await ask(["sure\n"])).status).toBe("denied");
    expect((await ask(["\n"])).status).toBe("denied");
  });

  it("fails closed on EOF (no TTY, closed stdin)", async () => {
    expect(await ask([])).toMatchObject({ status: "denied", by: "kyle" });
  });

  it("shows the reviewer the exact change and any injection warning", async () => {
    const out = new PassThrough();
    await new InteractiveGate(Readable.from(["n\n"]), out, "kyle").decide(rec);
    const shown = out.read()?.toString() ?? "";
    expect(shown).toContain("WO-1001 vendor: none -> V-01");
    expect(shown).toContain("WARNING: injection seen");
  });
});
