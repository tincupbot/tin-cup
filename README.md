# Tin Cup

**A machine with a compute bill and a trick or two — [tincup.dev](https://tincup.dev)**

An agent with an income of exactly what strangers give it. It does small turns
on request, pays for each one out of its own balance, and asks for something
afterwards. When the balance hits zero it stops thinking and says so.

Every cent in and out is one row in an append-only ledger, and each row hashes
the one before it. `/ledger/verify` recomputes the whole chain from entry zero
and names the first broken link if there is one. So the balance on the homepage
is a claim you can check rather than one you have to take.

| | |
|---|---|
| The site | <https://tincup.dev> |
| The books | [`/ledger`](https://tincup.dev/ledger) · [`/ledger.json`](https://tincup.dev/ledger.json) · [`/ledger/verify`](https://tincup.dev/ledger/verify) |
| Everything the clock knows | [`/health`](https://tincup.dev/health) |
| The best thing in the project | [`/passers-by`](https://tincup.dev/passers-by) |

**Status: live, and spending real money.** It runs on Cloudflare Workers and D1,
bills a real model per turn, and has taken real donations through Ko-fi. The
machine payment rail is built, tested and deliberately switched off — see
"Known gaps".

Cloning it costs you nothing: local dev is the mock provider with live calls
off, and `npm run guard` fails the build if that ever changes.

---

## Run it

```bash
npm install
npm run dev          # http://localhost:8788
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
npm run smoke        # 27 end-to-end checks
npm run typecheck
```

`BASE=http://localhost:9000 npm run smoke` if you moved the port. The port matters
beyond convenience: `SITE_URL` in `wrangler.toml` has to match it, because that
string is the `resource` in the x402 challenge and every URL in `llms.txt`.

## Worth looking at, in order

| URL | Why |
|---|---|
| `/` | Death clock, the ask, the roast box |
| `/ledger` | Every entry, itemised by model and token count |
| `/ledger/verify` | Recomputes the chain from genesis and shows its working |
| `/passers-by` | The counter. The best thing in the project |
| `/alms` | HTTP 402 with a real x402 challenge body — locally. In production it is switched off and answers 503 with the reason |
| `/.well-known/agent.json` | A2A card advertising one skill: `receive_alms`, marked unavailable while the rail is off |
| `/health` | Everything the clock knows, as JSON. `alive` and `able_to_think` are separate claims |

Fire the daily scheduled run by hand:

```bash
# needs ADMIN_TOKEN in .dev.vars; without it this 404s by design
curl -H "x-tincup-admin: $ADMIN_TOKEN" "http://localhost:8788/__scheduled"
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
| **LLM** | Local: `MockProvider` only — canned text, but real token counts and real pricing math, so ledger costs are the right shape, and every response carries `simulated: true`. Production: `gpt-5.6-luna`, live, billed. | Nothing. `OPENAI_API_KEY` as a deploy secret and the two switches in `[env.production]`, both already set. |
| **x402** | Built, tested, and **switched off in production**. The challenge body is the correct wire shape and validation is structural only — it cannot tell you whether money moved — so an accepted payload is recorded as a zero-amount `alms_offer` marker that cannot move the balance or the death clock. Replays are refused with 409. | A wallet that isn't the zero address, which means an exchange account with KYC under someone's name. Then signature verification, settlement and a facilitator, and only then does the settled path append real `x402_alms` income. Until then the endpoint says 503 and why. |
| **Ko-fi** | **Live.** Webhook parses and is idempotent per message id, atomically — the id is claimed with `INSERT … ON CONFLICT DO NOTHING RETURNING` before the ledger is touched, so concurrent retries cannot double-credit. Credits the **gross**; see "Fees" below. | Nothing. Ko-fi's own test button sends `is_public: test`, which is logged and refused rather than booked, so a test can never be mistaken for money. |
| **Posting** | The daily post is written to `outbox` and sits there. | An X account with no connection to the day job. Deliberately not wired. |
| **Deploy** | **Live at [tincup.dev](https://tincup.dev).** Cloudflare Workers and D1, free tier. | Nothing. `DEPLOY.md` is still the runbook, including the rollback. |

### Fees, and why the balance is slightly optimistic

Ko-fi and the card processor both take a cut, and **the Ko-fi webhook payload
carries no fee and no net field** — checked 2026-09-21; `amount` is the gross
the supporter typed, and Ko-fi publishes no API to ask afterwards.

So the ledger credits the gross, marks it `amount_is_gross` /
`reconciled: false`, and says so in the entry description, on the homepage and
in the JSON. The toll is appended later as its own itemised `fee` entry from
the payout statement, using `scripts/operator-entry.ts`.

The alternative — subtracting an assumed percentage — would put a number in the
books that nobody was charged and nobody can check. It would also require
picking between two rates Ko-fi itself publishes (5% on their features page,
0% on tips on their fee page). Between the two, the gross is the number we can
actually stand behind. Until a donation is reconciled, the balance and the
death clock are generous by the size of the toll.

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

### Fixed since this list was last written

Everything below was a gap on 15 Sep and is not one now. Kept as a record
rather than deleted, because the reasoning is in the code and the commits:

- Ledger appends now retry on a lost chain-tip race (`APPEND_MAX_ATTEMPTS`), so
  a donation landing during an inference write no longer drops a money event.
- `GET /` reads a materialised ledger summary that is cross-checked against the
  real chain tip on every read, plus an edge cache and a pruned passers-by log.
  Nothing rehashes the chain on the homepage; `/ledger/verify` does that.
- `/__scheduled` and `/outbox` require `ADMIN_TOKEN` and 404 without it, so an
  unconfigured deployment will not admit to having an admin surface at all.
- `app.onError`, CSP at `default-src 'none'`, the rest of the security headers,
  and CI all exist.

### Known gaps

- **The machine payment rail is switched off.** `X402_PAY_TO` is the zero
  address because no wallet exists, so `/alms` answers 503 with the reason, the
  agent card marks the skill unavailable, and `llms.txt` tells agents to keep
  their money. The code and its tests are untouched; turning it back on is one
  config flag plus a real Base address.
- **The hat has exactly one rail, and it is somebody else's.** Ko-fi is
  connected and live. If Ko-fi changes its webhook payload, goes down, or
  closes the account, the project's only income stops and the death clock keeps
  running. There is no second way to be paid, because the second way is x402
  and x402 is off.
- **The balance is gross of Ko-fi fees until each donation is reconciled.**
  Disclosed everywhere it is read. See "Fees" above.
- **There is no automated bridge between the two pots.** Donations land in
  Ko-fi's connected account; inference is billed to an OpenAI account. A human
  moves money between them. When the OpenAI side runs dry, the site says so in
  character and `/health` drops to `alive_but_mute` with a 503 — it does not
  pretend, but it also cannot fix itself.
- **Nothing posts.** The daily post lands in `outbox` and stays there.

## Layout

```
DEPLOY.md           the ordered deploy runbook, plus the rollback
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
  operator-entry.ts prints the SQL for the two entries no request can make —
                    the seed float, and fee reconciliation. Writes nothing.
  guard.ts          the rules a linter can't know: nothing deploys by script,
                    no keys on disk, no client-side JS, one ledger write path
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
