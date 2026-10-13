import { describe, expect, it } from "vitest";
import { entityTables, Store } from "../src/domain/store.js";
import type { Db } from "../src/domain/types.js";
import { AutoGate } from "../src/runtime/approvals.js";
import { startRun } from "../src/runtime/loop.js";
import { rollbackRun } from "../src/runtime/rollback.js";
import { RunStore } from "../src/runtime/state.js";
import { readJson, SEED_PATH } from "../src/util.js";
import { auditEvents, scripted, tempHome, workOrder } from "./helpers.js";

const seedTables = entityTables({ ...readJson<Db>(SEED_PATH), journal: [] });

const twoWrites = scripted([
  {
    tool_calls: [
      { name: "assign_vendor", input: { work_order_id: "WO-1001", vendor_id: "V-01", reason: "leak" } },
      { name: "update_work_order_status", input: { work_order_id: "WO-1001", status: "scheduled", reason: "assigned" } },
    ],
  },
  { text: "done" },
]);

async function approvedRun(home: string) {
  const state = await startRun("ops-coordinator", "schedule WO-1001", twoWrites, { home, gate: new AutoGate("approved") });
  expect(workOrder(home, "WO-1001")).toMatchObject({ vendorId: "V-01", status: "scheduled" });
  return state;
}

describe("rollback", () => {
  it("undoes every write of a run in one atomic commit and marks the run rolled back", async () => {
    const home = tempHome();
    const state = await approvedRun(home);
    const result = rollbackRun(state.runId, home);
    expect(result.ok).toBe(true);
    expect(result.reverted.map((e) => e.tool)).toEqual(["update_work_order_status", "assign_vendor"]); // newest first
    expect(entityTables(new Store(home).load())).toEqual(seedTables);
    expect(new RunStore(home).load(state.runId).status).toBe("rolled_back");
    expect(auditEvents(home, state.runId).at(-1)?.type).toBe("rollback_applied");
  });

  it("refuses, and changes nothing, if a record was modified after the run", async () => {
    const home = tempHome();
    const state = await approvedRun(home);
    new Store(home).commit((db) => {
      const wo = db.workOrders.find((w) => w.id === "WO-1001");
      if (wo) wo.status = "in_progress"; // the vendor started work
    });
    const result = rollbackRun(state.runId, home);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual(['WO-1001.status is "in_progress", expected "scheduled"']);
    expect(workOrder(home, "WO-1001")).toMatchObject({ vendorId: "V-01", status: "in_progress" }); // untouched
    expect(new Store(home).load().journal.every((j) => !j.rolledBackAt)).toBe(true);
    expect(auditEvents(home, state.runId).at(-1)).toMatchObject({ type: "rollback_rejected" });
  });

  it("is idempotent: a second rollback has nothing to revert", async () => {
    const home = tempHome();
    const state = await approvedRun(home);
    rollbackRun(state.runId, home);
    expect(rollbackRun(state.runId, home)).toMatchObject({ ok: true, reverted: [] });
    expect(entityTables(new Store(home).load())).toEqual(seedTables);
  });
});
