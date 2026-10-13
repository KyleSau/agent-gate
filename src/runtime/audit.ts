import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { nowIso, sha256 } from "../util.js";

export type AuditType =
  | "run_started"
  | "run_resumed"
  | "model_request"
  | "model_response"
  | "tool_call"
  | "policy_decision"
  | "approval_requested"
  | "approval_decided"
  | "tool_result"
  | "write_applied"
  | "injection_flagged"
  | "run_paused"
  | "run_completed"
  | "run_failed"
  | "rollback_applied"
  | "rollback_rejected";

export interface AuditEvent {
  seq: number;
  ts: string;
  runId: string;
  type: AuditType;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);
const hashOf = (e: Omit<AuditEvent, "hash">) =>
  sha256(`${e.prevHash}|${e.seq}|${e.ts}|${e.runId}|${e.type}|${JSON.stringify(e.data)}`);

/**
 * Append-only JSONL audit log, one file per run. The class exposes no update or delete, and
 * each line carries the hash of the previous line, so an edited or deleted line breaks the chain
 * (`verify`). That makes tampering detectable, not impossible: a production system would also
 * ship events to write-once storage.
 *
 * Tool results are logged after redaction: the audit log never holds more PII than the model saw.
 */
export class AuditLog {
  private seq = 0;
  private prevHash = GENESIS;

  constructor(
    readonly file: string,
    private readonly runId: string,
    private readonly onEvent?: (e: AuditEvent) => void,
  ) {
    const existing = AuditLog.read(file);
    const last = existing.at(-1);
    if (last) {
      this.seq = last.seq;
      this.prevHash = last.hash;
    }
  }

  append(type: AuditType, data: Record<string, unknown> = {}): AuditEvent {
    const partial = { seq: this.seq + 1, ts: nowIso(), runId: this.runId, type, data, prevHash: this.prevHash };
    const event: AuditEvent = { ...partial, hash: hashOf(partial) };
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    this.seq = event.seq;
    this.prevHash = event.hash;
    this.onEvent?.(event);
    return event;
  }

  static read(file: string): AuditEvent[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as AuditEvent);
  }

  /** Returns the seq of the first event that breaks the chain, or null if the log is intact. */
  static verify(events: AuditEvent[]): number | null {
    let prev = GENESIS;
    for (const [i, e] of events.entries()) {
      const { hash, ...rest } = e;
      if (e.seq !== i + 1 || e.prevHash !== prev || hashOf(rest) !== hash) return e.seq;
      prev = hash;
    }
    return null;
  }
}
