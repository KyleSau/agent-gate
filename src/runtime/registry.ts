import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { CATALOG } from "../tools/catalog.js";
import { AGENTS_DIR } from "../util.js";

/**
 * Agent registry: one YAML file per agent under agents/. Config-time policy is checked here,
 * so a bad grant fails at load instead of at 2 a.m. in production:
 *   - every granted tool must exist in the catalog
 *   - a low-risk agent may not hold WRITE grants
 */
export const AgentConfigSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  description: z.string(),
  owner: z.string().min(1),
  risk_tier: z.enum(["low", "medium", "high"]),
  pii_scope: z.enum(["none", "limited", "full"]),
  max_steps: z.number().int().min(1).max(50),
  tools: z.array(z.string()).min(1),
  instructions: z.string(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export function validateAgent(raw: unknown, source = "agent config"): AgentConfig {
  const parsed = AgentConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${source}: ${z.prettifyError(parsed.error)}`);
  const agent = parsed.data;
  for (const name of agent.tools) {
    const tool = CATALOG.get(name);
    if (!tool) throw new Error(`${source}: grants unknown tool "${name}"`);
    if (tool.tier === "write" && agent.risk_tier === "low") {
      throw new Error(`${source}: low-risk agent "${agent.name}" cannot be granted WRITE tool "${name}"`);
    }
  }
  return agent;
}

export function loadAgents(dir = AGENTS_DIR): AgentConfig[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => validateAgent(parse(readFileSync(path.join(dir, f), "utf8")), f));
}

export function loadAgent(name: string, dir = AGENTS_DIR): AgentConfig {
  const agent = loadAgents(dir).find((a) => a.name === name);
  if (!agent) throw new Error(`unknown agent "${name}" (see agents/*.yaml)`);
  return agent;
}
