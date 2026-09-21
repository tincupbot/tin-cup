/**
 * Emit the SQL for one hand-made ledger entry. PRINTS SQL; WRITES NOTHING.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, given that the whole project insists on one write path.
 * ---------------------------------------------------------------------------
 *
 * Two entries can never come from a web request, and both are mandatory:
 *
 *   1. THE SEED FLOAT. A production database straight out of `d1 migrations
 *      apply` has an empty ledger, which means a zero balance, which means the
 *      agent is born dead and the site renders a gravestone. Correct, and a
 *      terrible launch. The opening `startup_capital` entry has to come from
 *      somewhere, and there is deliberately no HTTP route that creates money.
 *
 *   2. FEE RECONCILIATION. The Ko-fi webhook reports the gross and no fee, so
 *      the books credit the gross and owe a correction. When the payout
 *      statement arrives, the real toll is appended as an itemised `fee` entry.
 *      See the header of src/kofi.ts.
 *
 * The alternative — an authenticated "append arbitrary money" endpoint — is a
 * far worse thing to have on the internet than a script that prints text.
 *
 * WHAT MAKES THIS SAFE RATHER THAN A SECOND WRITE PATH:
 *
 *   - It computes the hash with the same `entryHash` the app uses, over the
 *     same canonical preimage. There is no second hashing implementation.
 *   - The INSERT it prints is CONDITIONAL on the chain tip still being the one
 *     you hashed against. If a donation lands between you reading the head and
 *     you running the SQL, the statement writes ZERO ROWS rather than forking
 *     the chain. A fork would be permanent: the ledger has no delete path, so
 *     /ledger/verify would fail from that entry to the end of time.
 *   - It cannot edit or remove anything. The append-only triggers are still
 *     there and this only ever INSERTs.
 *   - Nothing it does is invisible: the entry lands in the same public ledger
 *     as everything else and /ledger/verify recomputes it from genesis.
 *
 * The materialised summary in `state` goes stale when you do this. That is
 * handled: `readLedgerState` compares its recorded tip against the real one on
 * every read and rebuilds when they disagree.
 *
 * ---------------------------------------------------------------------------
 * USE
 * ---------------------------------------------------------------------------
 *
 *   # the head to chain onto — 64 zeroes for the very first entry
 *   curl -s https://<host>/health | jq -r '.ledger.head'
 *
 *   node --experimental-strip-types scripts/operator-entry.ts \
 *     --direction in --kind startup_capital --amount-usd 20 \
 *     --description "Startup capital from the operator. Repayable never." \
 *     --prev-hash 0000000000000000000000000000000000000000000000000000000000000000
 *
 * Then run the printed statement, exactly as printed:
 *
 *   wrangler d1 execute tincup --remote --env production --command "<sql>"
 *
 * `wrangler` reports how many rows were written. One is success. Zero means the
 * head moved — re-read it and run this again. Then verify:
 *
 *   curl -s https://<host>/ledger/verify | jq '.valid, .entries'
 */

import { entryHash, GENESIS_PREV_HASH } from "../src/ledger/hash.ts";
import { IN_KINDS, OUT_KINDS, MARKER_KINDS } from "../src/ledger/ledger.ts";
import { usdToMicros } from "../src/money.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function die(message: string): never {
  console.error(`operator-entry: ${message}`);
  process.exit(1);
}

/** Single quotes doubled. Everything here ends up inside a SQL string literal. */
function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const directionArg = arg("direction");
if (directionArg !== "in" && directionArg !== "out") die(`--direction must be "in" or "out"`);
const direction: "in" | "out" = directionArg;

const kind = arg("kind");
const allowed = direction === "in" ? IN_KINDS : OUT_KINDS;
if (!kind || !(allowed as readonly string[]).includes(kind)) {
  die(`--kind for direction=${direction} must be one of: ${allowed.join(", ")}`);
}

const description = arg("description");
if (!description) die("--description is required; it is what the public ledger page shows");

const amountRaw = arg("amount-usd");
if (amountRaw === undefined) die("--amount-usd is required (use 0 for a marker entry)");
const amountUsd = Number(amountRaw);
if (!Number.isFinite(amountUsd) || amountUsd < 0) die(`--amount-usd must be a non-negative number`);
const amountMicros = usdToMicros(amountUsd);

if ((MARKER_KINDS as readonly string[]).includes(kind) && amountMicros !== 0) {
  die(`${kind} is a marker kind and must have amount 0 — the same rule append() enforces`);
}

const prevHash = arg("prev-hash");
if (!prevHash || !/^[0-9a-f]{64}$/.test(prevHash)) {
  die("--prev-hash must be 64 lowercase hex characters (the current chain head, or 64 zeroes for genesis)");
}

const ts = arg("ts") ?? new Date().toISOString();
const id = arg("id") ?? crypto.randomUUID();
const currency = "USD";

let metadata: Record<string, unknown>;
try {
  metadata = JSON.parse(arg("metadata") ?? "{}") as Record<string, unknown>;
} catch {
  die("--metadata must be valid JSON");
}
// Every entry made this way says so. Someone reading the books should be able
// to tell which entries came from a request and which came from a human.
metadata = { ...metadata, appended_out_of_band: true, tool: "scripts/operator-entry.ts" };

const payload = {
  id,
  ts,
  direction,
  amount_micros: amountMicros,
  currency,
  kind,
  description,
  metadata,
  prev_hash: prevHash,
};

const hash = await entryHash(payload);
const metadataJson = JSON.stringify(metadata);

// The guard: COALESCE gives the genesis hash when the table is empty, so one
// form covers both the first entry and every later one.
const sql = `INSERT INTO ledger (id, ts, direction, amount_micros, currency, kind, description, metadata, prev_hash, hash) SELECT ${q(id)}, ${q(ts)}, ${q(direction)}, ${amountMicros}, ${q(currency)}, ${q(kind)}, ${q(description)}, ${q(metadataJson)}, ${q(prevHash)}, ${q(hash)} WHERE COALESCE((SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1), ${q(GENESIS_PREV_HASH)}) = ${q(prevHash)};`;

console.log(`-- ${direction === "in" ? "+" : "-"}$${(amountMicros / 1_000_000).toFixed(6)} · ${kind}`);
console.log(`-- chains onto ${prevHash}`);
console.log(`-- produces    ${hash}`);
console.log(`--`);
console.log(`-- Writes 0 rows if the head has moved since you read it. 0 rows is not`);
console.log(`-- a failure to retry blindly: re-read the head and re-run this script.`);
console.log(sql);
