#!/usr/bin/env bash
#
# End-to-end smoke test against a running dev server.
#
#   npm run dev            # in one terminal
#   npm run smoke          # in another
#
# Checks behaviour, not just status codes: the chain verifies, the 402 is shaped
# like an x402 challenge, the rate limiter actually limits, the agent card
# advertises the skill. Exits non-zero on the first failure.

set -uo pipefail

BASE="${BASE:-http://localhost:8788}"
pass=0
fail=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n'  "$1"; fail=$((fail+1)); }

check_status() { # path expected label
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$1")
  [ "$got" = "$2" ] && ok "$3 ($1 -> $got)" || bad "$3 ($1 -> $got, wanted $2)"
}

check_body() { # path pattern label
  if curl -s "$BASE$1" | grep -qi -- "$2"; then ok "$3"; else bad "$3 (no /$2/ in $1)"; fi
}

echo "Tin Cup smoke test against $BASE"
echo

echo "Surfaces"
check_status "/"                          200 "front page"
check_status "/ledger"                    200 "ledger page"
check_status "/ledger.json"               200 "ledger json"
check_status "/ledger/verify"             200 "verify endpoint"
check_status "/passers-by"                200 "passers-by page"
check_status "/.well-known/agent.json"    200 "agent card"
check_status "/llms.txt"                  200 "llms.txt"
check_status "/health"                    200 "health"
check_status "/alms"                      402 "alms demands payment"

echo
echo "Substance"
check_body "/ledger/verify"            '"valid": *true'       "hash chain verifies"
check_body "/health"                   '"pricing_verified_on"' "health reports pricing date"
check_body "/.well-known/agent.json"   'receive_alms'          "agent card advertises receive_alms"
check_body "/llms.txt"                 'alms'                  "llms.txt points at the wallet"
check_body "/alms"                     'base-sepolia'          "402 names the network"

# x402 puts the challenge in the body, not a header — `x402Version` plus an
# `accepts` array of PaymentRequirements. No client can pay without both.
check_body "/alms" '"x402Version"' "402 body declares x402Version"
check_body "/alms" '"accepts"'     "402 body carries an accepts array"
check_body "/alms" '"scheme": *"exact"' "402 offers the exact scheme"

echo
echo "Money is not real"
check_body "/health" '"live_calls_enabled": *false' "live LLM calls are off"
if curl -s "$BASE/health" | grep -q '"isPlaceholder": *true'; then
  ok "wallet is flagged as a placeholder"
else
  bad "wallet is flagged as a placeholder — REAL ADDRESS CONFIGURED?"
fi

echo
echo "Roast + rate limit"
roast=$(curl -s -X POST "$BASE/roast" -H 'content-type: application/json' \
  -d '{"subject":"function doThing(){ if(true){ return true } else { return false } }"}')
if [ -n "$roast" ]; then ok "roast returns something"; else bad "roast returns something"; fi

# Two independent brakes can stop a roast: the per-IP rate limiter (429) and the
# global daily spend cap (503). Either one firing is the pass condition — which
# one fires depends on how much has already been spent today.
limited=no
for _ in 1 2 3 4 5 6 7 8 9 10; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/roast" \
    -H 'content-type: application/json' -d '{"subject":"more slop"}')
  if [ "$code" = "429" ]; then limited="rate limiter (429)"; break; fi
  if [ "$code" = "503" ]; then limited="spend cap (503)"; break; fi
done
[ "$limited" != no ] && ok "inference is rationed — $limited" || bad "nothing limited a roast in 10 tries"

echo
echo "A stranger cannot move the numbers"

# The invariant the whole project rests on: an unverified x402 payload is
# recorded, but credits nothing and does not move the death clock.
before=$(curl -s "$BASE/health" | grep -o '"balance_micros":[0-9-]*' | head -1)
nonce="smoke-$(date +%s)-$$"
now=$(date +%s)
auth="{\"from\":\"0x1111111111111111111111111111111111111111\",\"to\":\"0x2222222222222222222222222222222222222222\",\"value\":\"10000\",\"validAfter\":\"$((now-60))\",\"validBefore\":\"$((now+600))\",\"nonce\":\"$nonce\"}"
pay=$(printf '%s' "{\"x402Version\":1,\"scheme\":\"exact\",\"network\":\"base-sepolia\",\"payload\":{\"signature\":\"0xsig\",\"authorization\":$auth}}" | base64 | tr -d '\n')

curl -s "$BASE/alms" -H "X-PAYMENT: $pay" | grep -q '"credited_micros":0' \
  && ok "an unverified payment credits nothing" || bad "an unverified payment credits nothing"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/alms" -H "X-PAYMENT: $pay")
[ "$code" = "409" ] && ok "a replayed authorization is refused (409)" || bad "replay refused (got $code, wanted 409)"

after=$(curl -s "$BASE/health" | grep -o '"balance_micros":[0-9-]*' | head -1)
[ "$before" = "$after" ] && ok "the balance did not move" || bad "the balance moved: $before -> $after"

# A payer address that is not an address never reaches the ledger.
graffiti=$(printf '%s' "{\"x402Version\":1,\"scheme\":\"exact\",\"network\":\"base-sepolia\",\"payload\":{\"signature\":\"0xsig\",\"authorization\":{\"from\":\"CLICK-HERE-FREE-USDC\",\"to\":\"0x2\",\"value\":\"1\",\"validAfter\":\"0\",\"validBefore\":\"9999999999\",\"nonce\":\"g-$nonce\"}}}" | base64 | tr -d '\n')
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/alms" -H "X-PAYMENT: $graffiti")
[ "$code" = "402" ] && ok "a non-address payer is refused" || bad "non-address payer refused (got $code, wanted 402)"

# A spoofed crawler name is never published as fact.
curl -s -o /dev/null -H 'User-Agent: GPTBot/1.2 (+https://openai.com/gptbot)' "$BASE/llms.txt"
named=$(curl -s -H 'accept: application/json' "$BASE/passers-by" | grep -o '"named_line":"[^"]*"')
case "$named" in
  *"calling itself"*) ok "an unverified crawler is hedged, not accused" ;;
  *'"named_line":null'*|'') ok "no crawler named yet" ;;
  *) bad "an unverified crawler was named as fact: $named" ;;
esac

echo
printf 'passed %d, failed %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
