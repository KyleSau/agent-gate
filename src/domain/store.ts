import { existsSync } from "node:fs";
import path from "node:path";
import { readJson, SEED_PATH, writeJsonAtomic } from "../util.js";
import type { Db } from "./types.js";

/**
 * The "system of record": a JSON file under the agent-gate home directory, seeded from
 * data/seed.json. Single-writer by design; a production version would be Postgres with
 * the journal as a table written in the same transaction.
 */
export class Store {
  readonly file: string;

  constructor(home: string) {
    this.file = path.join(home, "db.json");
  }

  load(): Db {
    if (!existsSync(this.file)) this.reset();
    return readJson<Db>(this.file);
  }

  reset(): void {
    writeJsonAtomic(this.file, { ...readJson<Omit<Db, "journal">>(SEED_PATH), journal: [] });
  }

  /** Read-modify-write. If `mutate` throws, nothing is written. */
  commit<T>(mutate: (db: Db) => T): T {
    const db = this.load();
    const result = mutate(db);
    writeJsonAtomic(this.file, db);
    return result;
  }
}

/** The seed's entity tables, for "did anything change?" checks in tests and evals. */
export function entityTables(db: Db) {
  const { journal: _journal, ...tables } = db;
  return tables;
}
