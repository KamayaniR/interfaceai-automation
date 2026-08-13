#!/usr/bin/env bash
#
# Self-check: runs every scenario and ASSERTS the result, so you get PASS/FAIL rather
# than output to eyeball. No API key needed — this covers everything except discovery.
#
# Usage:  npm run verify        (starts and stops the target app itself)
#
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
ok   () { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad  () { printf '  \033[31m✗\033[0m %s\n     expected: %s\n     got:      %s\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); }

# --- start the target app if it isn't already up ------------------------------
STARTED_APP=0
if ! curl -s -o /dev/null --max-time 2 http://localhost:3100/; then
  echo "starting target app..."
  npx tsx --env-file-if-exists=.env target-app/server.ts > /tmp/verify-targetapp.log 2>&1 &
  APP_PID=$!
  STARTED_APP=1
  for _ in $(seq 1 30); do
    curl -s -o /dev/null --max-time 1 http://localhost:3100/ && break
    sleep 0.5
  done
fi
cleanup () { [ "$STARTED_APP" = "1" ] && kill "${APP_PID:-0}" 2>/dev/null; }
trap cleanup EXIT

# --- helper: run a replay and assert on its printed result --------------------
# check <description> <expected-substring> <cli args...>
check () {
  local desc="$1"; local want="$2"; shift 2
  local out
  out=$(npx tsx --env-file-if-exists=.env src/cli.ts replay "$@" 2>&1)
  if grep -qF "$want" <<<"$out"; then
    ok "$desc"
  else
    bad "$desc" "$want" "$(grep -E '^STATUS|^OUTCOME|^CLASS' <<<"$out" | tr '\n' ' ')"
  fi
}

CAP=member.read-savings-balance

echo
echo "── static checks ───────────────────────────────────────────"
if npx tsc --noEmit 2>/dev/null; then ok "typecheck"; else bad "typecheck" "no errors" "see: npm run typecheck"; fi
if npm test >/tmp/verify-tests.log 2>&1; then
  ok "unit tests ($(grep -oE '^# pass [0-9]+' /tmp/verify-tests.log | grep -oE '[0-9]+') passing)"
else
  bad "unit tests" "all passing" "see /tmp/verify-tests.log"
fi

echo
echo "── the core loop ───────────────────────────────────────────"
check "happy path returns the right balance" '"savingsBalance": "4,182.55"' \
  --capability $CAP --input memberId=100442
check "a different member returns a different balance" '"savingsBalance": "17,420.00"' \
  --capability $CAP --input memberId=100443

echo
echo "── business outcomes (answers, not crashes) ────────────────"
check "unknown member -> MEMBER_NOT_FOUND"    "OUTCOME  MEMBER_NOT_FOUND"      --capability $CAP --input memberId=999999
check "no permission  -> ACCESS_DENIED"       "OUTCOME  ACCESS_DENIED"         --capability $CAP --input memberId=100442 --fault permdenied
check "app validation -> MEMBER_NUMBER_INVALID" "OUTCOME  MEMBER_NUMBER_INVALID" --capability $CAP --input memberId=100442 --fault validation

echo
echo "── recoverable conditions (self-healing) ───────────────────"
check "session expiry -> re-authenticates and completes" "STATUS   success" \
  --capability $CAP --input memberId=100442 --fault timeout
check "unexpected dialog -> dismissed and completes"     "STATUS   success" \
  --capability $CAP --input memberId=100442 --fault dialog
check "transient slowness -> waited out"                 "STATUS   success" \
  --capability $CAP --input memberId=100442 --fault slow

echo
echo "── hard failures (loud, debuggable) ────────────────────────"
check "bad input rejected pre-flight" "CLASS    contract_violation" \
  --capability $CAP --input memberId=abc
check "undeclared input rejected"     "CLASS    contract_violation" \
  --capability $CAP --input memberId=100442 --input nonsense=1

echo
echo "── the discovered artifact (v2, produced by a real LLM run) ─"
check "discovered artifact replays on an unseen member" '"savingsBalance": "17,420.00"' \
  --capability $CAP --version 2 \
  --input memberNumber=100443 --input operatorId=OP1042 --input operatorPassword=x

echo
echo "── guardrails ──────────────────────────────────────────────"
OUT=$(npx tsx --env-file-if-exists=.env src/cli.ts replay --capability member.open-subaccount \
        --input memberId=100442 --input accountType=S2 --escalation-timeout 4000 2>&1)
if grep -q "escalation_timeout" <<<"$OUT"; then
  ok "irreversible step refuses to run unattended (escalates, then times out with nobody watching)"
else
  bad "irreversible step escalates" "escalation_timeout" "$(grep -E '^STATUS|^CLASS' <<<"$OUT" | tr '\n' ' ')"
fi

echo
echo "────────────────────────────────────────────────────────────"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
