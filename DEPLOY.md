# Deploying Tin Cup

An ordered runbook. Follow it top to bottom. Every command is exact; where a
value has to be pasted from the previous step, the step says so.

Deploying was approved by Ben on 2026-09-21. Nothing in this file should be run
by anyone else, and nothing in it runs itself — there is no `npm run deploy` and
`npm run guard` fails the build if someone adds one.

**Before you start you need:** a Cloudflare account, `wrangler login` completed,
a funded OpenAI API key, and the Ko-fi page at `ko-fi.com/tincupbot` with its
currency set to **USD**.

---

## 0. Preflight, locally

```bash
npm ci
npm run typecheck
npm test
```

Then, in two terminals:

```bash
npm run seed:dev && npm run dev     # terminal 1
npm run smoke                       # terminal 2
```

All three must be clean. `npm run smoke` needs `ROAST_RATE_LIMIT` at its
committed value of 5 — if your `.dev.vars` raises it for local convenience, run
the server as `npx wrangler dev --port 8788 --var ROAST_RATE_LIMIT:5` for this
check, or the rate-limiter assertion has nothing to trip on.

`npm run guard` must exit 0. Its escape-checking rule read expressions
naively until 21 Sep and reported 74 false positives; that is fixed, so a
finding now means something. Do not deploy past a red guard.

```bash
wrangler whoami      # confirm you are in the right Cloudflare account
```

---

## 1. Create the database

```bash
wrangler d1 create tincup
```

It prints a `database_id`. **Paste it into `wrangler.toml` under
`[[env.production.d1_databases]]`**, replacing the zero uuid. Leave the
top-level `[[d1_databases]]` block alone — that one is local dev and its
placeholder is ignored by miniflare.

Commit that change. A `database_id` is not a secret; it is useless without
account credentials.

## 2. Apply the schema

```bash
wrangler d1 migrations apply tincup --remote --env production
```

Confirm the tables landed:

```bash
wrangler d1 execute tincup --remote --env production \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Expect: `kofi_messages`, `ledger`, `lifecycle_events`, `outbox`,
`passersby`, `passersby_agents`, `passersby_daily`, `performances`,
`rate_limits`, `state`, `x402_nonces`.

## 3. Set the secrets

Three, all via `wrangler secret put`, which prompts for the value and never
writes it to disk or to this repo. Do not pass any of them as a command-line
argument, and do not paste any of them into a chat window.

```bash
wrangler secret put ADMIN_TOKEN --env production
wrangler secret put OPENAI_API_KEY --env production
wrangler secret put KOFI_VERIFICATION_TOKEN --env production
```

- **`ADMIN_TOKEN`** — a long random string you generate (`openssl rand -hex 32`).
  Gates `/__scheduled`, which spends money, and `/outbox`, which is a window
  onto unsent drafts. Unset, both endpoints 404 and the daily loop cannot be
  triggered by hand.
- **`OPENAI_API_KEY`** — the funded key. Production has
  `LLM_LIVE_CALLS_ENABLED = "true"`, so this key is what every busk is billed
  to. Until it is set, the site answers busks in character with "thinking is
  switched off in my own configuration" rather than 500ing.
- **`KOFI_VERIFICATION_TOKEN`** — from Ko-fi → Settings → API. Must be set
  before step 8 or the webhook refuses every donation with a 503, which is the
  correct behaviour and a bad surprise.

Check what is set (names only; values are never readable back):

```bash
wrangler secret list --env production
```

## 4. First deploy

```bash
wrangler deploy --env production
```

It prints the hostname, e.g. `https://tin-cup.something.workers.dev`.

The site is live at this point and **its `SITE_URL` is wrong**, which is
expected and is the next step.

## 5. Correct SITE_URL, then deploy again

Paste the real hostname into `SITE_URL` under `[env.production.vars]` in
`wrangler.toml`, replacing `https://tin-cup.<subdomain>.workers.dev`. No
trailing slash.

This is not cosmetic. `SITE_URL` is the `resource` field in the x402 challenge,
and it is every absolute URL in `llms.txt`, `/.well-known/agent.json`,
`sitemap.xml` and the `Sitemap:` line of `robots.txt`. Left as the placeholder,
the launch spends itself telling every crawler and every agent to go to a
hostname that does not resolve.

```bash
wrangler deploy --env production
curl -s https://<host>/llms.txt | grep -c '<subdomain>'   # must be 0
```

## 6. Seed the float

The production ledger is empty, which means the balance is zero, which means the
agent is born dead and the site renders a gravestone. That is arithmetically
correct and not a launch.

There is deliberately no HTTP route that creates money, so the opening entry is
made out of band. First prove the ledger really is empty — this is the step that
demonstrates no dev fixture ever reached production:

```bash
curl -s https://<host>/health | jq '{
  entries: .ledger.entries,
  valid:   .ledger.valid,
  head:    .ledger.head,
  fixture: .contains_dev_fixture_data
}'
```

**Required:** `entries: 0`, `valid: true`, `fixture: false`, and `head` equal to
64 zeroes. Anything else means something has written to this database already —
stop and find out what, because the ledger has no delete path and whatever is in
it is in it permanently.

Then generate the entry and run it:

```bash
node --experimental-strip-types scripts/operator-entry.ts \
  --direction in --kind startup_capital --amount-usd 20 \
  --description "Startup capital from the operator. Repayable never." \
  --prev-hash 0000000000000000000000000000000000000000000000000000000000000000

# paste the printed INSERT, exactly as printed:
wrangler d1 execute tincup --remote --env production --command "<the INSERT>"
```

The script prints SQL and writes nothing itself. The statement it prints is
conditional on the chain tip still being what you hashed against, so it writes
**1 row** on success and **0 rows** if anything landed in between. Zero rows is
not a failure to retry blindly — re-read the head and re-run the script.

```bash
curl -s https://<host>/ledger/verify | jq '{valid, entries, head}'
```

`valid: true`, `entries: 1`.

The same script is how fee reconciliation entries are appended later; see the
header of `src/kofi.ts`.

## 7. Verify the deployment

Replace `<host>` throughout.

```bash
# 1. Alive, solvent, able to think, books intact, no fixture money.
curl -s https://<host>/health | jq '{
  status, alive, able_to_think,
  balance: .balance_display,
  ledger: .ledger.valid,
  fixture: .contains_dev_fixture_data,
  provider: .llm.provider,
  live: .llm.live_calls_enabled,
  provider_ok: .llm.provider_status.ok,
  pricing: .llm.pricing_verified_on,
  x402_enabled: .x402.enabled,
  kofi: .kofi_configured,
  admin: .admin_endpoints_configured
}'
```

Expect `status: "alive"`, `able_to_think: true`, `ledger: true`,
`fixture: false`, `provider: "openai"`, `live: true`, `provider_ok: true`,
`x402_enabled: false`, `kofi: true`, `admin: true`, and HTTP 200. A 503 here
means one of `alive`, `ledger.valid` or `provider_status.ok` is false, and the
body says which.

```bash
# 2. The chain recomputes from genesis.
curl -s https://<host>/ledger/verify | jq '{valid, entries, first_bad_index}'

# 3. The counter answers and is counting you.
curl -s -H 'accept: application/json' https://<host>/passers-by | jq '.totals'

# 4. The agent card is honest about the payment rail being off.
curl -s https://<host>/.well-known/agent.json | jq '{
  url,
  skill: .skills[0].name,
  available: (.skills[0].description | startswith("CURRENTLY UNAVAILABLE") | not),
  accepting: .x_tin_cup.payment.accepting,
  alive: .x_tin_cup.alive
}'
```

`accepting` must be `false` and `available` must be `false`. `url` must be the
real hostname, not the placeholder.

```bash
# 5. /alms refuses honestly rather than issuing a challenge nobody can pay.
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/alms     # 503
curl -s https://<host>/alms | jq '{accepting_payment, do_not_pay, counted}'
```

```bash
# 6. The busk. This one spends real money — a few hundredths of a cent.
curl -s -X POST https://<host>/busk \
  -H 'content-type: application/json' \
  -d '{"turn":"roast","subject":"example.com — the seamless way to leverage synergy"}' \
  | jq '{text: .text[0:120], cost_micros, model, simulated, death_moved_closer_by}'
```

`simulated` must be **`false`** — that is the proof the live provider is
actually wired. `model` must be `gpt-5.6-luna`. Then confirm it reached the
books and the clock moved:

```bash
curl -s https://<host>/ledger.json | jq '.entries[-1] | {kind, amount_micros, description, metadata}'
curl -s https://<host>/ledger/verify | jq '.valid'
```

The entry's `metadata.pricing_verified_on` should read `2026-09-21`, and
`input_micros_per_mtok` / `output_micros_per_mtok` should be `200000` and
`1200000` — $0.20 and $1.20 per MTok, the rates verified live that day.

```bash
# 7. The operator endpoints are shut to everyone without the token.
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/__scheduled           # 404
curl -s -o /dev/null -w '%{http_code}\n' -H "x-tincup-admin: $ADMIN_TOKEN" \
  https://<host>/__scheduled                                                   # 200
```

The authenticated call runs the agent loop, which spends money and writes the
day's post to `outbox`. Read it back:

```bash
curl -s -H "x-tincup-admin: $ADMIN_TOKEN" https://<host>/outbox | jq '.posts[0].body'
```

Nothing sends it. Nothing in this repo can send anything.

## 8. Wire up the Ko-fi webhook

Ko-fi → Settings → API:

- **Webhook URL:** `https://<host>/webhook/kofi`
- **Verification Token:** the same value you put in `KOFI_VERIFICATION_TOKEN`.

Ko-fi's own page has a "send test payment" button. **It does not create a ledger
entry, and it must not** — it is a correctly-signed webhook for a donation
nobody was charged for, and the ledger has no delete path. `src/kofi.ts`
recognises it, answers 200 so Ko-fi stops retrying, and books nothing.

So the proof is the delivery log, not the books:

```bash
# Did anything arrive at all? Public, and null until the webhook has ever fired.
curl -s https://<host>/health | jq '{kofi_configured, kofi_dry_run, kofi_last_delivery_at}'

# What arrived, and what was done with it. Operator-only.
curl -s -H "x-tincup-admin: $ADMIN_TOKEN" https://<host>/webhooks | jq '.deliveries[0]'
```

Expect `outcome: "test_payment"` (or `"dry_run"` if you deployed with
`--var KOFI_DRY_RUN:true`), `http_status: 200`, `ledger_id: null`, and the
`currency` Ko-fi actually sends — which is the field worth reading, see below.

A rejected delivery lands here too, with its reason, which is the difference
between "Ko-fi never called" and "Ko-fi called and was turned away". Before this
log existed, those two looked identical unless somebody happened to be running
`wrangler tail` at that exact second.

To prove the path that *does* book money, take a real donation — or tip the page
a dollar yourself and reconcile it later. Send the same delivery twice: the
second must come back `outcome: "duplicate"` pointing at the same `ledger_id`.

Three things that will bite here:

- **Currency.** `src/kofi.ts` rejects anything that is not USD with a 400. A
  Ko-fi page defaulting to EUR means every donation is refused, never reaches
  the books, and sits in the payment provider while the death clock ignores it.
  Set the page to USD before taking a real donation.
- **The amount is the gross.** The ledger credits what the supporter typed, not
  what arrives after Ko-fi's cut and the processor's. That gap is disclosed
  everywhere and corrected later from the payout statement, with
  `scripts/operator-entry.ts` and `--kind fee`.
- **Turn the dry run off once it is proved.** While `KOFI_DRY_RUN` is on, a
  genuine donation is verified, acknowledged with a 200 and *dropped* — which is
  worse than anything it protects against. Redeploy without the `--var` and
  confirm `kofi_dry_run: false` on `/health`.

## 9. Afterwards

The cron in `[triggers]` fires the agent loop daily at 09:00 UTC. It reconciles
the lifecycle, runs queued performances, prunes, rebuilds the ledger summary,
and writes the day's post to `outbox`.

Watch the first day:

```bash
wrangler tail --env production --format pretty
```

---

## Rollback

**The deployment rolls back. The ledger does not.** That asymmetry is the whole
design: entries are append-only, enforced by SQLite triggers, and there is no
production reset path and there must not be one. If the books are ever wrong,
the honest fix is a correcting entry appended in public, never a rewrite.

### Roll back the code

```bash
wrangler deployments list --env production
wrangler rollback [<deployment-id>] --env production
```

`wrangler rollback` with no id goes to the previous deployment. Bindings and
secrets are unaffected.

### Stop it spending money, without taking it down

Fastest first:

```bash
# Freeze inference. The site stays up, the books stay readable, busks answer
# in character rather than erroring.
wrangler deploy --env production --var LLM_LIVE_CALLS_ENABLED:false
```

Or flip `LLM_PROVIDER` to `mock` — but be careful: the mock produces
`simulated: true` entries at Anthropic's prices, and those land in the same
public ledger as real ones. They are labelled, everywhere, but a production
ledger with simulated entries in it is a worse artefact than a quiet one.
Prefer `LLM_LIVE_CALLS_ENABLED:false`.

The blunter instruments, in order of severity:

```bash
# Tighten the daily cap to near zero.
wrangler deploy --env production --var DAILY_SPEND_CAP_MICROS:1

# Revoke the key at the provider. The site stays up and says it cannot think.
# /health drops to alive_but_mute + 503. Nothing is billed while this is true.
```

### Take it down

```bash
wrangler delete --env production
```

This removes the Worker. **It does not delete the D1 database**, which is what
you want: the books survive the site. Redeploying against the same
`database_id` resumes exactly where it stopped, death clock included.

Deleting the database is deleting the project's entire claim to honesty. If it
ever has to happen, it is Ben's call and it is made in public.
