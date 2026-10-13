#!/usr/bin/env node
// Entry point for MCP clients: `node dist/src/mcp/stdio.js --agent maintenance-triage`
import { parseArgs } from "node:util";
import { defaultHome } from "../util.js";
import { startStdioServer } from "./server.js";

const { values } = parseArgs({ options: { agent: { type: "string" } } });
// Defaults to the least-privileged agent.
await startStdioServer(values.agent ?? process.env.AGENT_GATE_AGENT ?? "maintenance-triage", defaultHome());
