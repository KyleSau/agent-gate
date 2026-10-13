// Reproduces the scripted demo transcript shown in the README (npm run demo).
// Uses the ScriptedModel only, an isolated state dir (.agent-gate/demo), and no API key.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const env = { ...process.env, AGENT_GATE_HOME: ".agent-gate/demo" };
rmSync(env.AGENT_GATE_HOME, { recursive: true, force: true });

function agentGate(...args) {
  const shown = args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  console.log(`$ agent-gate ${shown}`);
  let out;
  try {
    out = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { env, encoding: "utf8" });
  } catch (err) {
    out = err.stdout; // non-zero exits are part of the demo (e.g. a rejected rollback)
  }
  console.log(`${out.trimEnd()}\n`);
  return out;
}

const match = (text, re) => {
  const m = text.match(re);
  if (!m) throw new Error(`demo: expected ${re} in output`);
  return m[1];
};

agentGate("reset");
agentGate("run", "maintenance-triage", "--model", "scripted", "--approvals", "queue",
  "--task", "Triage today's new work orders and draft an update for the resident with the most urgent issue.");

const ops = agentGate("run", "ops-coordinator", "--model", "scripted", "--approvals", "queue",
  "--task", "Schedule WO-1001 (bathroom leak at Maple Court 101) with the right vendor.");
const runId = match(ops, /run (run_\w+):/);
agentGate("approvals", "list");
const second = agentGate("approvals", "approve", match(ops, /Paused for approval (apr_\w+)/), "--by", "kyle");
agentGate("approvals", "approve", match(second, /Paused for approval (apr_\w+)/), "--by", "kyle");
agentGate("audit", runId);
agentGate("rollback", runId);
