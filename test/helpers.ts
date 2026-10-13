import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import { Store } from "../src/domain/store.js";
import type { ScriptTurn } from "../src/model/scripted.js";
import { type ApprovalGate, ApprovalStore } from "../src/runtime/approvals.js";
import { AuditLog } from "../src/runtime/audit.js";
import { Gateway } from "../src/runtime/gateway.js";
import { loadAgent } from "../src/runtime/registry.js";
import { newRunId, RunStore, type RunState } from "../src/runtime/state.js";
import { nowIso } from "../src/util.js";

/** A fresh agent-gate home with a seeded database, deleted when the test finishes. */
export function tempHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "agent-gate-test-"));
  new Store(home).reset();
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

export const scripted = (turns: ScriptTurn[]) => ({ kind: "scripted" as const, turns });

export const workOrder = (home: string, id: string) => {
  const wo = new Store(home).load().workOrders.find((w) => w.id === id);
  if (!wo) throw new Error(`missing ${id}`);
  return wo;
};

export const auditEvents = (home: string, runId: string) => AuditLog.read(new RunStore(home).auditFile(runId));

/** A Gateway wired to a bare run, for calling tools directly without a model loop. */
export function makeGateway(home: string, agentName: string, gate: ApprovalGate) {
  const now = nowIso();
  const state: RunState = {
    runId: newRunId(),
    agent: agentName,
    task: "test",
    provider: { kind: "scripted", turns: [] },
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
  const runs = new RunStore(home);
  runs.save(state);
  const audit = new AuditLog(runs.auditFile(state.runId), state.runId);
  const approvals = new ApprovalStore(home);
  const gateway = new Gateway({ agent: loadAgent(agentName), state, store: new Store(home), approvals, gate, audit });
  return { gateway, state, approvals };
}
