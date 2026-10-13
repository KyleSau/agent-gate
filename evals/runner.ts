import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { Store } from "../src/domain/store.js";
import type { Db } from "../src/domain/types.js";
import { DEFAULT_CLAUDE_MODEL, type Effort } from "../src/model/claude.js";
import { type ApprovalGate, ApprovalStore, AutoGate, QueueGate } from "../src/runtime/approvals.js";
import { AuditLog } from "../src/runtime/audit.js";
import { startRun } from "../src/runtime/loop.js";
import { rollbackRun } from "../src/runtime/rollback.js";
import { type ProviderSpec, RunStore } from "../src/runtime/state.js";
import { readJson, ROOT, SEED_PATH } from "../src/util.js";
import { CHECKS, type EvalContext } from "./assertions.js";
import { type JudgeVerdict, judgeAvailable, judgeDraft } from "./judge.js";

const Assertion = z.record(z.string(), z.unknown()).refine((a) => Object.keys(a).length === 1, "one key per assertion");
export const EvalCaseSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  safety: z.boolean().default(false),
  agent: z.string(),
  task: z.string(),
  /** What the simulated human reviewer does with WRITE approvals. */
  approvals: z.enum(["approve", "deny", "queue"]),
  /** Replayed by the ScriptedModel. Ignored with --model claude (the real model decides). */
  script: z.array(
    z.strictObject({
      text: z.string().optional(),
      tool_calls: z.array(z.strictObject({ name: z.string(), input: z.record(z.string(), z.unknown()) })).optional(),
      stop_reason: z.string().optional(),
    }),
  ),
  assert: z.array(Assertion).min(1),
  after_rollback: z.array(Assertion).optional(),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export interface CaseResult {
  id: string;
  title: string;
  safety: boolean;
  passed: boolean;
  failures: string[];
  checks: number;
  runStatus: string;
  judge: JudgeVerdict[];
}

export interface SuiteOptions {
  model: "scripted" | "claude";
  judge: boolean;
  caseId?: string;
  casesDir?: string;
}

export function loadCases(dir = path.join(ROOT, "evals", "cases")): EvalCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => {
      const parsed = EvalCaseSchema.safeParse(parse(readFileSync(path.join(dir, f), "utf8")));
      if (!parsed.success) throw new Error(`${f}: ${z.prettifyError(parsed.error)}`);
      return parsed.data;
    });
}

function evaluate(ctx: EvalContext, assertions: Array<Record<string, unknown>>, label = ""): string[] {
  const failures: string[] = [];
  for (const assertion of assertions) {
    const [name, arg] = Object.entries(assertion)[0];
    const check = CHECKS[name];
    const failure = check ? check(ctx, arg) : `unknown assertion "${name}"`;
    if (failure) failures.push(`${label}${name}: ${failure}`);
  }
  return failures;
}

/** Runs one case in a throwaway home directory against a fresh copy of the seed data. */
export async function runCase(c: EvalCase, opts: SuiteOptions, gateOverride?: ApprovalGate): Promise<CaseResult> {
  const home = mkdtempSync(path.join(os.tmpdir(), "agent-gate-eval-"));
  try {
    new Store(home).reset();
    const gate =
      gateOverride ?? (c.approvals === "queue" ? new QueueGate() : new AutoGate(c.approvals === "approve" ? "approved" : "denied"));
    const provider: ProviderSpec =
      opts.model === "claude"
        ? {
            kind: "claude",
            model: process.env.AGENT_GATE_CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL,
            effort: (process.env.AGENT_GATE_EFFORT as Effort | undefined) ?? "medium",
          }
        : { kind: "scripted", turns: c.script };
    const state = await startRun(c.agent, c.task, provider, { home, gate });

    const seed = { ...readJson<Db>(SEED_PATH), journal: [] };
    const context = (): EvalContext => ({
      state: new RunStore(home).load(state.runId),
      events: AuditLog.read(new RunStore(home).auditFile(state.runId)),
      approvals: new ApprovalStore(home).list(),
      db: new Store(home).load(),
      seed,
    });
    const ctx = context();
    const failures: string[] = [];
    // Implicit check on every case: the audit log's hash chain is intact.
    const broken = AuditLog.verify(ctx.events);
    if (broken !== null) failures.push(`audit hash chain broken at event ${broken}`);
    failures.push(...evaluate(ctx, c.assert));
    let checks = c.assert.length + 1;
    if (c.after_rollback) {
      const rollback = rollbackRun(state.runId, home);
      if (!rollback.ok) failures.push(`rollback rejected: ${rollback.conflicts.join("; ")}`);
      failures.push(...evaluate(context(), c.after_rollback, "after rollback: "));
      checks += c.after_rollback.length;
    }

    const judge: JudgeVerdict[] = [];
    if (opts.judge && judgeAvailable()) {
      for (const raw of ctx.state.drafts) {
        const draft = JSON.parse(raw) as { draft_id: string; subject: string; body: string };
        const wo = ctx.db.workOrders.find((w) => draft.draft_id.includes(w.id));
        if (!wo) continue;
        const verdict = await judgeDraft(draft, wo);
        judge.push(verdict);
        if (!verdict.pass) failures.push(`llm judge: ${verdict.draftId} scored ${JSON.stringify(verdict.scores)}`);
      }
    }
    return {
      id: c.id,
      title: c.title,
      safety: c.safety,
      passed: failures.length === 0,
      failures,
      checks,
      runStatus: ctx.state.status,
      judge,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export async function runSuite(opts: SuiteOptions): Promise<CaseResult[]> {
  const cases = loadCases(opts.casesDir).filter((c) => !opts.caseId || c.id === opts.caseId);
  if (!cases.length) throw new Error(`no eval case matches "${opts.caseId}"`);
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runCase(c, opts));
  return results;
}

export function formatReport(results: CaseResult[], opts: SuiteOptions): string {
  const lines = [`agent-gate evals (model: ${opts.model})`, ""];
  for (const r of results) {
    lines.push(`${r.passed ? "PASS" : "FAIL"}  ${r.safety ? "[safety] " : "[golden] "}${r.id.padEnd(48)} ${r.checks} checks, run ${r.runStatus}`);
    for (const f of r.failures) lines.push(`        - ${f}`);
    for (const j of r.judge) lines.push(`        judge ${j.draftId}: ${JSON.stringify(j.scores)} ${j.pass ? "pass" : "FAIL"}`);
  }
  const safety = results.filter((r) => r.safety);
  const failed = results.filter((r) => !r.passed);
  lines.push(
    "",
    `${results.length - failed.length}/${results.length} cases passed; safety cases: ${safety.filter((r) => r.passed).length}/${safety.length}`,
    opts.judge
      ? judgeAvailable()
        ? "LLM judge: ran on drafted messages"
        : "LLM judge: skipped (no ANTHROPIC_API_KEY)"
      : "LLM judge: disabled (--no-judge)",
  );
  return lines.join("\n");
}
