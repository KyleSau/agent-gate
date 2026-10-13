import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root: the nearest directory with a package.json (works from src/ under tsx and from dist/). */
export const ROOT = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("agent-gate: could not locate package root");
    dir = parent;
  }
  return dir;
})();

export const SEED_PATH = path.join(ROOT, "data", "seed.json");
export const AGENTS_DIR = path.join(ROOT, "agents");

/** Mutable state (db, runs, approvals) lives here. Tests and evals pass a temp dir instead. */
export function defaultHome(): string {
  return path.resolve(process.env.AGENT_GATE_HOME ?? path.join(ROOT, ".agent-gate"));
}

export const nowIso = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${randomBytes(5).toString("hex")}`;
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/**
 * Write-to-temp then rename. A reader never sees a half-written file, and a crash
 * leaves either the old version or the new one. That is the whole durability story.
 */
export function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      // Windows can briefly lock a file that another process (or AV scanner) has open.
      if (attempt >= 5 || (err as NodeJS.ErrnoException).code !== "EPERM") throw err;
    }
  }
}
