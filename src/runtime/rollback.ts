import { Store } from "../domain/store.js";
import type { JournalEntry, WorkOrder } from "../domain/types.js";
import { nowIso } from "../util.js";
import { AuditLog } from "./audit.js";
import { RunStore } from "./state.js";

export interface RollbackResult {
  ok: boolean;
  reverted: JournalEntry[];
  conflicts: string[];
}

class RollbackConflict extends Error {
  constructor(readonly conflicts: string[]) {
    super("rollback conflict");
  }
}

/**
 * Undo every WRITE a run applied, newest first, as one atomic commit.
 *
 * Each journal entry holds the inverse (`before`) of its change. Before restoring a field we
 * check that it still holds the value this run wrote (`after`). If anything else changed it
 * since, we refuse the whole rollback rather than silently clobber someone else's update.
 * The checks and the restores happen on an in-memory copy, so a conflict writes nothing.
 */
export function rollbackRun(runId: string, home: string): RollbackResult {
  const runs = new RunStore(home);
  const state = runs.load(runId);
  const audit = new AuditLog(runs.auditFile(runId), runId);
  try {
    const reverted = new Store(home).commit((db) => {
      const entries = db.journal.filter((j) => j.runId === runId && !j.rolledBackAt).reverse();
      const conflicts: string[] = [];
      const at = nowIso();
      for (const entry of entries) {
        const wo = db.workOrders.find((w) => w.id === entry.workOrderId);
        if (!wo) {
          conflicts.push(`${entry.workOrderId} no longer exists`);
          continue;
        }
        for (const [field, value] of Object.entries(entry.after)) {
          const current = wo[field as keyof WorkOrder];
          if (current !== value) {
            conflicts.push(`${wo.id}.${field} is ${JSON.stringify(current)}, expected ${JSON.stringify(value)}`);
          }
        }
        Object.assign(wo, entry.before);
        entry.rolledBackAt = at;
      }
      if (conflicts.length) throw new RollbackConflict(conflicts);
      return entries;
    });
    audit.append("rollback_applied", {
      reverted: reverted.map((e) => ({ journalId: e.id, workOrderId: e.workOrderId, restored: e.before })),
    });
    if (reverted.length) {
      state.status = "rolled_back";
      runs.save(state);
    }
    return { ok: true, reverted, conflicts: [] };
  } catch (err) {
    if (!(err instanceof RollbackConflict)) throw err;
    audit.append("rollback_rejected", { conflicts: err.conflicts });
    return { ok: false, reverted: [], conflicts: err.conflicts };
  }
}
