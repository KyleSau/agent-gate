import type { AuditEvent } from "./runtime/audit.js";
import type { RunState } from "./runtime/state.js";

const json = (v: unknown) => JSON.stringify(v);
const clip = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n)}...` : s).replace(/\s+/g, " ");

/** One line per audit event; used both for live run output and `agent-gate audit <runId>`. */
export function formatEvent(e: AuditEvent): string {
  const s = (key: string) => String(e.data[key] ?? "");
  const list = (key: string) => (e.data[key] as unknown[] | undefined) ?? [];
  const detail = (() => {
    switch (e.type) {
      case "run_started":
        return `agent=${s("agent")} owner=${s("owner")} risk=${s("risk_tier")} pii=${s("pii_scope")} model=${s("provider")} approvals=${s("approvals")}`;
      case "run_resumed":
        return `from ${s("from")}`;
      case "model_request":
        return `step ${s("step")} -> ${s("provider")}`;
      case "model_response":
        return `stop=${s("stopReason")}${list("toolCalls").length ? ` calls=${json(list("toolCalls"))}` : ""}${e.data.fallback ? ` fallback=${s("fallback")}` : ""}`;
      case "tool_call":
        return `${s("tool")} ${clip(json(e.data.input), 140)}`;
      case "policy_decision":
        return `${s("effect").toUpperCase()} ${s("tool")}: ${s("reason")}`;
      case "approval_requested":
        return `${s("approvalId")}: ${s("change")}${list("warnings").length ? " [injection warning attached]" : ""}`;
      case "approval_decided":
        return `${s("approvalId")} ${s("status").toUpperCase()} by ${s("by")} (via ${s("via")})`;
      case "tool_result":
        return e.data.isError ? `${s("tool")} ERROR: ${clip(s("error"))}` : `${s("tool")} ok (${s("redactions")} PII values redacted)`;
      case "write_applied":
        return `${s("workOrderId")} ${json(e.data.before)} -> ${json(e.data.after)} (approval ${s("approvalId")})`;
      case "injection_flagged":
        return list("flags").join("; ");
      case "run_paused":
        return `awaiting approval ${s("approvalId")}`;
      case "run_completed":
        return `${s("steps")} model turns, ${s("drafts")} draft(s)`;
      case "run_failed":
        return s("reason");
      case "rollback_applied":
        return `${list("reverted").length} change(s) reverted`;
      case "rollback_rejected":
        return list("conflicts").join("; ");
      default:
        return json(e.data);
    }
  })();
  return `  #${String(e.seq).padStart(3, "0")} ${e.ts.slice(11, 19)}  ${e.type.padEnd(18)} ${detail}`;
}

export function formatOutcome(state: RunState): string {
  const lines = [`\nrun ${state.runId}: ${state.status.toUpperCase()} after ${state.steps} model turn(s)`];
  if (state.error) lines.push(`reason: ${state.error}`);
  if (state.finalText) lines.push(`\n--- final answer (${state.provider.kind} model) ---\n${state.finalText}`);
  for (const draft of state.drafts) {
    const { subject, body } = JSON.parse(draft) as { subject: string; body: string };
    lines.push(`\n--- draft for human review (NOT sent) ---\nSubject: ${subject}\n${body}`);
  }
  if (state.status === "awaiting_approval") {
    lines.push(
      `\nPaused for approval ${state.awaitingApproval}. Decide with:`,
      `  agent-gate approvals approve ${state.awaitingApproval}    (or: approvals deny ${state.awaitingApproval})`,
    );
  }
  return lines.join("\n");
}
