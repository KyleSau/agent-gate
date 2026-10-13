import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ScriptTurn } from "../model/scripted.js";
import type { MessageParam, ToolCall, ToolResultBlockParam, ToolSpec } from "../model/types.js";
import { nowIso, readJson, writeJsonAtomic } from "../util.js";

export type RunStatus = "running" | "awaiting_approval" | "completed" | "failed" | "refused" | "rolled_back";

export type ProviderSpec =
  | { kind: "scripted"; turns: ScriptTurn[] }
  | { kind: "claude"; model: string; effort: "low" | "medium" | "high" | "xhigh" | "max" }
  | { kind: "mcp" }; // an MCP session: the MCP client is the model loop

/**
 * Everything needed to continue a run after a crash or a restart. Saved (atomically) after
 * every model turn and after every tool result, so the most a crash can lose is the step in flight.
 */
export interface RunState {
  runId: string;
  agent: string;
  task: string;
  provider: ProviderSpec;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  steps: number;
  /** Frozen at run start, so a resumed run sends a byte-identical prefix (prompt cache, thinking-block binding). */
  system: string;
  tools: ToolSpec[];
  /** Append-only transcript in Anthropic message format. */
  messages: MessageParam[];
  /** Tool calls from the latest assistant turn plus results checkpointed so far. */
  pendingTurn: { calls: ToolCall[]; results: ToolResultBlockParam[] } | null;
  awaitingApproval?: string;
  injectionFlags: string[];
  drafts: string[];
  finalText?: string;
  error?: string;
}

const RUN_ID = /^(run|mcp)_[0-9a-z_]+$/;

export function newRunId(prefix: "run" | "mcp" = "run"): string {
  const stamp = nowIso().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
  return `${prefix}_${stamp}_${randomBytes(2).toString("hex")}`;
}

export class RunStore {
  constructor(readonly home: string) {}

  dir(runId: string): string {
    if (!RUN_ID.test(runId)) throw new Error(`invalid run id "${runId}"`);
    return path.join(this.home, "runs", runId);
  }

  auditFile(runId: string): string {
    return path.join(this.dir(runId), "audit.jsonl");
  }

  load(runId: string): RunState {
    const file = path.join(this.dir(runId), "state.json");
    if (!existsSync(file)) throw new Error(`no run with id "${runId}"`);
    return readJson<RunState>(file);
  }

  save(state: RunState): void {
    state.updatedAt = nowIso();
    writeJsonAtomic(path.join(this.dir(state.runId), "state.json"), state);
  }

  list(): RunState[] {
    const root = path.join(this.home, "runs");
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((id) => RUN_ID.test(id) && existsSync(path.join(root, id, "state.json")))
      .map((id) => this.load(id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
