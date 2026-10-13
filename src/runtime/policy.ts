import { CATALOG, type Tier, type ToolDef } from "../tools/catalog.js";
import type { AgentConfig } from "./registry.js";

export type Effect = "allow" | "deny" | "require_approval";

export interface PolicyDecision {
  effect: Effect;
  reason: string;
  tier?: Tier;
}

/**
 * The runtime policy. Deliberately small and deterministic: the decision depends only on the
 * agent's config and the tool's tier, never on anything the model said.
 */
export function decide(agent: AgentConfig, toolName: string): PolicyDecision {
  const tool = CATALOG.get(toolName);
  if (!tool) return { effect: "deny", reason: `unknown tool "${toolName}"` };
  if (!agent.tools.includes(toolName)) {
    return { effect: "deny", reason: `"${toolName}" is not granted to agent "${agent.name}"`, tier: tool.tier };
  }
  if (tool.tier === "write") {
    return { effect: "require_approval", reason: "WRITE tools always require a recorded human approval", tier: "write" };
  }
  return { effect: "allow", reason: `${tool.tier.toUpperCase()} tool granted to agent`, tier: tool.tier };
}

/**
 * The agent's toolbox: the only tool implementations its gateway can reach. A tool that is not
 * granted is not in this map, so there is no code path that executes it, whatever the model asks for.
 */
export function toolbox(agent: AgentConfig): ReadonlyMap<string, ToolDef> {
  return new Map(agent.tools.map((name) => [name, CATALOG.get(name) as ToolDef]));
}
