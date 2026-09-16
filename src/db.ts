/**
 * The narrow slice of D1 this project actually uses.
 *
 * Everything below the route layer is written against `Db`, not `D1Database`.
 * That is what lets the whole app be tested against Node's built-in `node:sqlite`
 * with no Workers runtime, no miniflare pool, and no extra dependency.
 *
 * There is deliberately no schema in this file any more. DDL used to run on the
 * request path — thirteen idempotent CREATEs per cold isolate, on the way to
 * rendering a page. The schema now lives in `migrations/` and is applied out of
 * band by `wrangler d1 migrations apply`, which is both cheaper and the only
 * way to know what a production database actually contains.
 */

export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface Db {
  prepare(sql: string): DbStatement;
}

/**
 * Raised when a query fails because the schema is not there.
 *
 * Worth its own error because the fix is a specific command rather than a code
 * change, and the first thing anyone does with a fresh checkout is hit this.
 */
export class SchemaMissingError extends Error {
  constructor(cause: string) {
    super(
      `the database has no schema yet — run \`npm run db:migrate\` (local) or ` +
        `\`wrangler d1 migrations apply tincup --remote\`. Underlying error: ${cause}`,
    );
    this.name = "SchemaMissingError";
  }
}

export function isMissingTable(err: unknown): boolean {
  return /no such table/i.test(String((err as Error)?.message ?? err));
}

export async function getState(db: Db, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM state WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setState(db: Db, key: string, value: string): Promise<void> {
  await db
    .prepare(`INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(key, value)
    .run();
}
