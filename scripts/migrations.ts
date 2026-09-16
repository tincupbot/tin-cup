/**
 * Apply `migrations/*.sql` to a node:sqlite database.
 *
 * NODE ONLY — the tests and the dev tooling. The Worker never applies its own
 * schema; `wrangler d1 migrations apply` does that, out of band, from the same
 * files. One definition of the schema, two ways to run it, no second copy.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

// `new URL(...)` resolves to the Workers URL type under this tsconfig, which is
// structurally incompatible with node:url's. The string overload sidesteps it.
const ROOT = join(fileURLToPath(new URL(".", import.meta.url).href), "..");
export const MIGRATIONS_DIR = join(ROOT, "migrations");

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Every table this project owns, in an order safe to drop. Dev reset only. */
export const ALL_TABLES = [
  "ledger",
  "passersby",
  "passersby_daily",
  "passersby_agents",
  "kofi_messages",
  "x402_nonces",
  "rate_limits",
  "outbox",
  "performances",
  "state",
  "lifecycle_events",
];

export function applyMigrations(sqlite: DatabaseSync): string[] {
  const applied: string[] = [];
  for (const file of migrationFiles()) {
    // `exec` runs every statement in the file, which matters: the append-only
    // triggers contain semicolons inside BEGIN…END and naive splitting mangles
    // them.
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    applied.push(file);
  }
  return applied;
}

/**
 * Drop everything, then re-apply. DEV ONLY.
 *
 * The append-only triggers guard rows, not tables, so DROP still works — which
 * is the only reason a polluted dev ledger is recoverable at all. There is no
 * equivalent for production and there must not be: the whole value of the books
 * is that nobody, including me, can start them again.
 */
export function resetDatabase(sqlite: DatabaseSync): string[] {
  for (const t of ALL_TABLES) sqlite.exec(`DROP TABLE IF EXISTS ${t}`);
  sqlite.exec(`DROP TRIGGER IF EXISTS ledger_no_update`);
  sqlite.exec(`DROP TRIGGER IF EXISTS ledger_no_delete`);
  return applyMigrations(sqlite);
}
