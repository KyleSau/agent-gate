import { existsSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { WritePlan } from "../tools/catalog.js";
import { nowIso, readJson, writeJsonAtomic } from "../util.js";

export type ApprovalStatus = "pending" | "approved" | "denied";

/** One human decision about one exact WRITE call. Persisted before and after the decision. */
export interface ApprovalRecord {
  id: string;
  runId: string;
  agent: string;
  tool: string;
  toolUseId: string;
  input: unknown;
  /** The exact field change the approver sees and approves. Re-checked at execution time. */
  change: WritePlan;
  warnings: string[];
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
  executedAt?: string;
}

export class ApprovalStore {
  readonly dir: string;

  constructor(home: string) {
    this.dir = path.join(home, "approvals");
  }

  save(rec: ApprovalRecord): void {
    writeJsonAtomic(path.join(this.dir, `${rec.id}.json`), rec);
  }

  get(id: string): ApprovalRecord {
    const file = path.join(this.dir, `${id}.json`);
    if (!/^apr_[a-f0-9]+$/.test(id) || !existsSync(file)) throw new Error(`no approval with id "${id}"`);
    return readJson<ApprovalRecord>(file);
  }

  list(): ApprovalRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<ApprovalRecord>(path.join(this.dir, f)))
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  findByCall(runId: string, toolUseId: string): ApprovalRecord | undefined {
    return this.list().filter((a) => a.runId === runId && a.toolUseId === toolUseId).at(-1);
  }

  /** Records a decision on a pending approval. Decisions are final: no re-deciding. */
  decide(id: string, status: "approved" | "denied", by: string, reason?: string): ApprovalRecord {
    const rec = this.get(id);
    if (rec.status !== "pending") throw new Error(`approval ${id} is already ${rec.status}`);
    Object.assign(rec, { status, decidedBy: by, decidedAt: nowIso(), reason });
    this.save(rec);
    return rec;
  }
}

export interface GateDecision {
  status: ApprovalStatus;
  by?: string;
  reason?: string;
}

/** How a pending approval gets decided. Every gate's decision lands in the same ApprovalStore. */
export interface ApprovalGate {
  readonly mode: string;
  decide(rec: ApprovalRecord): Promise<GateDecision>;
}

/** Non-interactive: persist the request and pause the run. A human decides later via the CLI. */
export class QueueGate implements ApprovalGate {
  readonly mode = "queue";
  async decide(): Promise<GateDecision> {
    return { status: "pending" };
  }
}

/** Asks on the terminal. Anything other than "y"/"yes", including EOF, is a denial (fail closed). */
export class InteractiveGate implements ApprovalGate {
  readonly mode = "interactive";

  constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
    private readonly reviewer = userInfo().username,
  ) {}

  async decide(rec: ApprovalRecord): Promise<GateDecision> {
    this.output.write(formatApprovalRequest(rec));
    const rl = createInterface({ input: this.input, output: this.output, terminal: false });
    const answer = await new Promise<string>((resolve) => {
      rl.once("close", () => resolve("")); // EOF / Ctrl-D: no answer
      rl.question("Approve this change? [y/N] ", resolve);
    });
    rl.close();
    const approved = /^y(es)?$/i.test(answer.trim());
    return { status: approved ? "approved" : "denied", by: this.reviewer, reason: "decided at CLI prompt" };
  }
}

/** Fixed decision. Only for tests and evals, where it stands in for a reviewer. */
export class AutoGate implements ApprovalGate {
  readonly mode = "auto";
  constructor(private readonly status: "approved" | "denied") {}
  async decide(): Promise<GateDecision> {
    return { status: this.status, by: "simulated-reviewer (eval)", reason: `auto-${this.status}` };
  }
}

export function formatApprovalRequest(rec: ApprovalRecord): string {
  const reason = (rec.input as { reason?: string })?.reason;
  return [
    "",
    "---- approval required ----------------------------------------",
    `  approval: ${rec.id}    run: ${rec.runId}    agent: ${rec.agent}`,
    `  tool:     ${rec.tool} (WRITE)`,
    `  change:   ${rec.change.summary}`,
    reason ? `  agent's reason: ${reason}` : "",
    ...rec.warnings.map((w) => `  WARNING: ${w}`),
    "----------------------------------------------------------------",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n")
    .concat("\n");
}
