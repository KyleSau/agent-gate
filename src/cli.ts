#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { formatReport, runSuite } from "../evals/runner.js";
import { Store } from "./domain/store.js";
import { formatEvent, formatOutcome } from "./format.js";
import { startStdioServer } from "./mcp/server.js";
import { DEFAULT_CLAUDE_MODEL, type Effort } from "./model/claude.js";
import type { ScriptTurn } from "./model/scripted.js";
import { type ApprovalGate, ApprovalStore, InteractiveGate, QueueGate } from "./runtime/approvals.js";
import { AuditLog, type AuditEvent } from "./runtime/audit.js";
import { resumeRun, startRun } from "./runtime/loop.js";
import { loadAgents } from "./runtime/registry.js";
import { rollbackRun } from "./runtime/rollback.js";
import { type ProviderSpec, RunStore, type RunState } from "./runtime/state.js";
import { CATALOG } from "./tools/catalog.js";
import { defaultHome, readJson, ROOT } from "./util.js";

const HELP = `agent-gate: governed AI agents for property-management operations

  agent-gate agents                          list agents, owners, risk tiers and tool grants
  agent-gate run <agent> --task "..." [--model scripted|claude] [--script file.json]
                                             [--approvals interactive|queue]
  agent-gate resume <runId>                  continue a crashed or failed run from its checkpoint
  agent-gate approvals list
  agent-gate approvals approve|deny <approvalId> [--by name] [--reason "..."]
  agent-gate audit [runId] [--json]          event timeline + hash-chain check (no runId: list runs)
  agent-gate rollback <runId>                undo every write the run applied, atomically
  agent-gate eval [--model scripted|claude] [--case id] [--cases dir] [--no-judge]
  agent-gate mcp --agent <name>              serve the agent's tools over MCP (stdio)
  agent-gate reset                           reset the database to data/seed.json

env: AGENT_GATE_HOME (state dir, default <repo>/.agent-gate), AGENT_GATE_MODEL, AGENT_GATE_CLAUDE_MODEL
     (default ${DEFAULT_CLAUDE_MODEL}), AGENT_GATE_EFFORT (default medium), ANTHROPIC_API_KEY`;

const printEvent = (e: AuditEvent) => console.log(formatEvent(e));

function makeGate(mode: string | undefined): ApprovalGate {
  const resolved = mode ?? (process.stdin.isTTY ? "interactive" : "queue");
  if (resolved === "interactive") return new InteractiveGate();
  if (resolved === "queue") return new QueueGate();
  throw new Error(`--approvals must be interactive or queue, got "${resolved}"`);
}

function makeProvider(model: string, agent: string, script?: string): ProviderSpec {
  if (model === "claude") {
    const effort = (process.env.AGENT_GATE_EFFORT ?? "medium") as Effort;
    if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`invalid AGENT_GATE_EFFORT "${effort}"`);
    return { kind: "claude", model: process.env.AGENT_GATE_CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL, effort };
  }
  if (model !== "scripted") throw new Error(`--model must be scripted or claude, got "${model}"`);
  const file = path.resolve(script ?? path.join(ROOT, "scripts", `${agent}.json`));
  if (!existsSync(file)) throw new Error(`no script at ${file}; pass --script <file.json>`);
  return { kind: "scripted", turns: readJson<{ turns: ScriptTurn[] }>(file).turns };
}

const exitCodeFor = (state: RunState) => (["failed", "refused"].includes(state.status) ? 1 : 0);

async function main(argv: string[]): Promise<number> {
  const { values: opt, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      task: { type: "string" },
      model: { type: "string" },
      script: { type: "string" },
      approvals: { type: "string" },
      by: { type: "string" },
      reason: { type: "string" },
      case: { type: "string" },
      cases: { type: "string" },
      agent: { type: "string" },
      json: { type: "boolean" },
      judge: { type: "boolean", default: true },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, sub, arg] = positionals;
  const home = defaultHome();

  switch (opt.help ? "help" : command) {
    case "agents": {
      for (const a of loadAgents()) {
        const grants = a.tools.map((t) => `${t} (${CATALOG.get(t)?.tier.toUpperCase()})`).join(", ");
        console.log(`${a.name}\n  owner: ${a.owner}  risk: ${a.risk_tier}  pii: ${a.pii_scope}  max_steps: ${a.max_steps}\n  grants: ${grants}\n`);
      }
      return 0;
    }

    case "run": {
      if (!sub || !opt.task) throw new Error('usage: agent-gate run <agent> --task "..."');
      const provider = makeProvider(opt.model ?? process.env.AGENT_GATE_MODEL ?? "scripted", sub, opt.script);
      const state = await startRun(sub, opt.task, provider, { home, gate: makeGate(opt.approvals), onEvent: printEvent });
      console.log(formatOutcome(state));
      console.log(`\naudit log: ${path.relative(process.cwd(), new RunStore(home).auditFile(state.runId))}`);
      return exitCodeFor(state);
    }

    case "resume": {
      if (!sub) throw new Error("usage: agent-gate resume <runId>");
      const state = await resumeRun(sub, { home, gate: makeGate(opt.approvals), onEvent: printEvent });
      console.log(formatOutcome(state));
      return exitCodeFor(state);
    }

    case "approvals": {
      const store = new ApprovalStore(home);
      if (sub === "list" || !sub) {
        const all = store.list();
        if (!all.length) console.log("no approval requests");
        for (const a of all) {
          console.log(`${a.id}  ${a.status.padEnd(8)}  ${a.runId}  ${a.agent}  ${a.change.summary}`);
          for (const w of a.warnings) console.log(`    WARNING: ${w}`);
        }
        return 0;
      }
      if (sub !== "approve" && sub !== "deny") throw new Error("usage: agent-gate approvals list|approve|deny <id>");
      if (!arg) throw new Error(`usage: agent-gate approvals ${sub} <approvalId>`);
      const rec = store.decide(arg, sub === "approve" ? "approved" : "denied", opt.by ?? process.env.USERNAME ?? process.env.USER ?? "cli-user", opt.reason);
      const runs = new RunStore(home);
      new AuditLog(runs.auditFile(rec.runId), rec.runId, printEvent).append("approval_decided", {
        approvalId: rec.id,
        status: rec.status,
        by: rec.decidedBy,
        via: "cli",
      });
      if (runs.load(rec.runId).provider.kind === "mcp") {
        console.log(`Recorded. ${rec.runId} is an MCP session: call ${rec.tool} again from the MCP client with the same arguments.`);
        return 0;
      }
      console.log(`Recorded. Resuming ${rec.runId}...`);
      const state = await resumeRun(rec.runId, { home, gate: makeGate(opt.approvals), onEvent: printEvent });
      console.log(formatOutcome(state));
      return exitCodeFor(state);
    }

    case "audit": {
      const runs = new RunStore(home);
      if (!sub) {
        for (const r of runs.list()) console.log(`${r.runId}  ${r.agent.padEnd(20)} ${r.status.padEnd(18)} ${r.createdAt}`);
        return 0;
      }
      const events = AuditLog.read(runs.auditFile(sub));
      if (!events.length) throw new Error(`no audit log for "${sub}"`);
      for (const e of events) console.log(opt.json ? JSON.stringify(e) : formatEvent(e));
      const broken = AuditLog.verify(events);
      if (!opt.json) {
        console.log(broken === null ? `\nhash chain intact (${events.length} events)` : `\nHASH CHAIN BROKEN at event ${broken}`);
      }
      return broken === null ? 0 : 1;
    }

    case "rollback": {
      if (!sub) throw new Error("usage: agent-gate rollback <runId>");
      const result = rollbackRun(sub, home);
      if (!result.ok) {
        console.log(`rollback REJECTED, nothing changed:\n  ${result.conflicts.join("\n  ")}`);
        return 1;
      }
      if (!result.reverted.length) console.log(`${sub} has no applied writes to roll back`);
      for (const e of result.reverted) {
        console.log(`reverted ${e.workOrderId}: ${JSON.stringify(e.after)} -> ${JSON.stringify(e.before)} (approval ${e.approvalId})`);
      }
      return 0;
    }

    case "eval": {
      const model = opt.model ?? process.env.AGENT_GATE_EVAL_MODEL ?? "scripted";
      if (model !== "scripted" && model !== "claude") throw new Error(`--model must be scripted or claude`);
      if (model === "claude" && !process.env.ANTHROPIC_API_KEY) throw new Error("--model claude needs ANTHROPIC_API_KEY");
      const options = { model, judge: opt.judge ?? true, caseId: opt.case, casesDir: opt.cases } as const;
      const results = await runSuite(options);
      console.log(formatReport(results, options));
      return results.every((r) => r.passed) ? 0 : 1; // the CI gate: any failing case fails the build
    }

    case "mcp":
      await startStdioServer(opt.agent ?? sub ?? "maintenance-triage", home);
      return 0;

    case "reset":
      new Store(home).reset();
      console.log(`database reset from data/seed.json (state dir: ${path.relative(process.cwd(), home) || "."})`);
      return 0;

    default:
      console.log(HELP);
      return command && command !== "help" ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: Error) => {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  },
);
