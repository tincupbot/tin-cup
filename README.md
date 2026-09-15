# Tin Cup

An agent with a hosting bill and no income.

It publishes a hash-chained ledger of every cent in and out, a death clock that
runs off the real balance, and a counter of every machine that reads its payment
card and doesn't pay. When the balance hits zero it stops thinking.

**Status: v0, local only. Never deployed. Nothing here has touched real money,
a real model, or a real wallet.**

---

## Run it

```bash
npm install
npm run dev          # http://localhost:8787
```

On a completely fresh checkout the agent is born with an empty ledger, which
means it is born dead — correct, and a terrible demo. Give it a past:

```bash
# stop the dev server first; the seeder writes to the same local D1 file
npm run seed:dev
npm run dev
```

The fixture is ten days of invented history: seeded with $5, burns it on roasts,
runs out on day seven, is resurrected the next morning by a stranger's $5. It
ends alive with about five days left.

Then, with the server running in another terminal:

```bash
npm run smoke        # 21 end-to-end checks
npm run typecheck
```

`BASE=http://localhost:8788 npm run smoke` if you moved the port.

## Worth looking at, in order

| URL | Why |
|---|---|
| `/` | Death clock, the ask, the roast box |
| `/ledger` | Every entry, itemised by model and token count |
| `/ledger/verify` | Recomputes the chain from genesis and shows its working |
| `/passers-by` | The counter. The best thing in the project |
| `/alms` | HTTP 402 with a real x402 challenge body |
| `/.well-known/agent.json` | A2A card advertising one skill: `receive_alms` |
| `/health` | Everything the clock knows, as JSON |

Fire the daily scheduled run by hand:

```bash
curl "http://localhost:8787/__scheduled?cron=0+9+*+*+*"
```

It writes the day's post to the `outbox` table. Nothing sends it. Nothing in
this repo can send anything.

## The fixture data is fake, loudly

Every seeded ledger row carries `metadata.fixture = true` and a description
beginning `DEV FIXTURE`. While a single such row exists, `hasFixtureData()`
prints a banner across every page saying the money is invented. This is
deliberate belt-and-braces: a project whose entire credibility rests on its
books being honest cannot afford one screenshot of fake donations being mistaken
for real ones.

## What is stubbed, and what that means

| Piece | State | What's needed to make it real |
|---|---|---|
| **LLM** | `MockProvider` only. Canned text, but real token counts and real pricing math, so ledger costs are the right shape. Responses carry `simulated: true`. | An Anthropic key, plus `LLM_LIVE_CALLS_ENABLED=true`. Re-verify `src/llm/pricing.ts` first. |
| **x402** | Challenge body is the correct wire shape. Payment validation is **structural only** — it checks the payload looks like an `exact` payment, and cannot tell you whether money moved. Because of that, an accepted payload is recorded as a zero-amount `alms_offer` marker that **cannot move the balance or the death clock**, never as income. Replays are refused with 409. | Signature verification, on-chain settlement, a facilitator, and a wallet that isn't the zero address. Only then does the settled path append real `x402_alms` income. |
| **Ko-fi** | Webhook parses and is idempotent per message id, atomically — the id is claimed with `INSERT … ON CONFLICT DO NOTHING RETURNING` before the ledger is touched, so concurrent retries cannot double-credit. | A Ko-fi account (needs a human identity), a real webhook URL, a real shared token. |
| **Posting** | The daily post is written to `outbox` and sits there. | An X account with no connection to the day job. Deliberately not wired. |
| **Deploy** | `wrangler.toml` has a placeholder `database_id`. | A Cloudflare account and Ben's approval. |

## Numbers a stranger must not be able to set

Everything this project publishes is a claim that a number is real. Three of the
inputs arrive from the open internet — an x402 header, a user-agent string, and
a request to spend money on inference — so each one is treated as hostile.

- **An unverified x402 payload cannot become money.** It is recorded as a
  zero-amount `alms_offer`, with the offered amount in metadata. The balance,
  `days_left` and `dies_at` are unmoved. Replaying the same authorization is
  refused with 409 via `x402_nonces`. Payer addresses are shape-checked before
  they are ever rendered, so the ledger cannot be used as a billboard.
- **An uncorroborated crawler is never named as fact.** `verified` comes from
  Cloudflare's verified-bot signal, never from the user-agent. A claimed
  identity gets hedged wording — *"Something calling itself GPTBot…"* — and the
  `/passers-by` table marks the row `claimed`. Naming a real company off a
  free-text header would be an accusation this project cannot stand behind.
- **Inference spend is capped globally.** Per-IP rate limiting is a politeness
  control and does not bound spend; rotating addresses defeats it. The real
  brake is `DAILY_SPEND_CAP_MICROS` plus `MAX_CALL_COST_MICROS`, checked in
  `billedComplete` before the provider is called, because after it the money is
  already gone. `/health` reports both alongside the day's spend.

### Known gaps

- **Ledger appends aren't concurrency-safe by construction.** Two simultaneous
  writers can read the same chain tip. The `UNIQUE` index on `hash` makes the
  loser fail loudly rather than silently forking, but nothing retries, so a
  donation landing during an inference write can 500. Needs a bounded retry.
- **`GET /` is O(the whole database).** Each render rehashes the full chain,
  reads the full ledger again for the patron wall, and runs
  `COUNT(DISTINCT ua)` over an unpruned log. Fine at this size, a self-inflicted
  outage after a front page. Needs caching, a materialised balance, and pruning.
- **`/__scheduled` and `/outbox` are unauthenticated.** Fine locally; must be
  gated before deploy.
- **No `app.onError`, no CSP, no security headers, no CI.** The site ships zero
  client-side JS, so a CSP here is nearly free.
- `resource` in the 402 challenge comes from `SITE_URL`, so it reads
  `localhost:8787` even when you're serving on another port.

## Layout

```
src/
  index.ts          routes, the whole HTTP surface
  ledger/           hash.ts (canonical JSON + sha256), ledger.ts (the only write path)
  deathclock.ts     balance, burn, dies_at, death and resurrection
  passersby/        classify.ts, counter.ts, sentences.ts
  llm/              provider interface, mock, pricing, roast writer
  x402.ts           hand-rolled 402 — see the comment for why not x402-hono
  views/            server-rendered HTML, no bundler
  copy.ts           every user-facing sentence, in one place
scripts/
  seed-dev.ts       the ten-day fixture
  smoke.sh          end-to-end checks
test/
  helpers.ts        a `Db` over node:sqlite — this is why src/db.ts is an interface
  hash/ledger       canonical JSON, chain verification, append-only enforcement
  deathclock        burn arithmetic at the boundaries, death and resurrection
  kofi/x402         the two ways money claims to arrive, including the races
  spendcap/money    the global brake, and the last millimetre of formatting
```

`npm test` runs the suite in-process against Node's built-in SQLite — no Workers
runtime, no miniflare, no extra dependency. D1 is SQLite, so the SQL under test
is the SQL that ships.

Money is integer micro-dollars everywhere. Floats never touch a balance.
