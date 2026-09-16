/**
 * Drop and re-create the LOCAL D1 database. DEV ONLY.
 *
 * Why this needs to exist as its own documented thing: the ledger's append-only
 * triggers refuse UPDATE and DELETE by design, so there is no way to clean a
 * polluted dev ledger with SQL. That is correct for production and intolerable
 * in development, where a half-finished experiment leaves entries you cannot
 * remove and a chain you cannot reason about.
 *
 * The triggers guard *rows*, not tables, so DROP TABLE still works. This script
 * is that escape hatch, made explicit and confined to the miniflare state
 * directory, rather than a sequence of SQL somebody rediscovers each time.
 *
 * THERE IS NO PRODUCTION EQUIVALENT AND THERE MUST NOT BE. The value of the
 * books is that nobody — including whoever runs this project — can start them
 * again. If a production ledger is ever wrong, the honest fix is a correcting
 * entry appended in public, not a reset.
 *
 *   npm run db:reset          # empty database, schema applied
 *   npm run seed:dev          # empty, then the ten-day fixture
 *
 * The dev server must not be running: miniflare holds the same file.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { resetDatabase } from "./migrations.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url).href), "..");
const D1_DIR = join(ROOT, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");

function findLocalD1(): string {
  let files: string[];
  try {
    files = readdirSync(D1_DIR);
  } catch {
    throw new Error(
      `No local D1 state at ${D1_DIR}.\n` +
        `Start the dev server once (npm run dev) so miniflare creates it, stop it, then re-run this.`,
    );
  }
  const candidates = files.filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one D1 database file in ${D1_DIR}, found: ${candidates.join(", ") || "none"}`);
  }
  return join(D1_DIR, candidates[0]!);
}

const path = findLocalD1();

// A last guard against this ever being pointed at something that is not the
// disposable local file.
if (!path.includes(".wrangler/state")) {
  throw new Error(`refusing to reset ${path}: not a miniflare state file`);
}

const sqlite = new DatabaseSync(path);
const before = (() => {
  try {
    return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ledger`).get() as { n: number }).n;
  } catch {
    return 0;
  }
})();

const applied = resetDatabase(sqlite);
sqlite.close();

console.log(`Reset local D1 at ${path}`);
console.log(`Dropped ${before} ledger entries. Applied: ${applied.join(", ")}`);
console.log(`The ledger is empty, which means the agent is born dead. Run \`npm run seed:dev\` to give it a past.`);
