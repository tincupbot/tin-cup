import { DatabaseSync } from "node:sqlite";
import type { Db, DbStatement } from "../src/db.ts";
import { applyMigrations } from "../scripts/migrations.ts";
import type { Env } from "../src/env.ts";

/**
 * A `Db` over Node's built-in SQLite.
 *
 * This is the whole reason `src/db.ts` defines a narrow `Db` interface instead
 * of taking `D1Database` everywhere: the money code can be tested in-process,
 * in milliseconds, with no Workers runtime and no extra dependency. D1 is
 * SQLite, so the SQL under test is the SQL that ships.
 */
class NodeStatement implements DbStatement {
  constructor(
    private readonly stmt: ReturnType<DatabaseSync["prepare"]>,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): DbStatement {
    return new NodeStatement(this.stmt, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.stmt.get(...(this.params as never[])) as T) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.stmt.all(...(this.params as never[])) as T[] };
  }

  async run(): Promise<unknown> {
    return this.stmt.run(...(this.params as never[]));
  }
}

export class NodeDb implements Db {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): DbStatement {
    return new NodeStatement(this.db.prepare(sql));
  }

  /** Escape hatch for tests that need to prove a trigger fires. */
  raw(): DatabaseSync {
    return this.db;
  }
}

/**
 * A fresh in-memory database with the schema applied.
 *
 * The schema comes from `migrations/*.sql` — the same files wrangler applies to
 * D1 — so a test can never pass against a schema that isn't the shipped one.
 */
export async function freshDb(): Promise<NodeDb> {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  return new NodeDb(sqlite);
}

/** A minimal Env. Overrides win; the defaults keep every live path switched off. */
export function testEnv(db: NodeDb, overrides: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    SITE_URL: "https://tincup.test",
    SITE_NAME: "Tin Cup",
    OPERATOR_CONTACT: "test@example.invalid",
    LLM_PROVIDER: "mock",
    LLM_LIVE_CALLS_ENABLED: "false",
    X402_ENABLED: "true",
    X402_NETWORK: "base-sepolia",
    X402_PRICE_MICROS: "10000",
    ...overrides,
  } as Env;
}

/** A valid-by-construction x402 header. Tests mutate one field at a time from here. */
export function paymentHeader(over: Record<string, unknown> = {}, authOver: Record<string, unknown> = {}): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "0x" + "ab".repeat(32),
      authorization: {
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
        value: "10000",
        validAfter: String(nowSec - 60),
        validBefore: String(nowSec + 600),
        nonce: `nonce-${Math.random().toString(36).slice(2)}`,
        ...authOver,
      },
    },
    ...over,
  };
  return btoa(JSON.stringify(payload));
}
