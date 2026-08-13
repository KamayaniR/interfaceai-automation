#!/usr/bin/env bash
# Regenerates /evidence/ from real runs against the live target app.
#
# Every scenario below is a genuine end-to-end replay — nothing here is hand-written
# output. Run `npm run target-app` in another shell first.
set -uo pipefail
cd "$(dirname "$0")/.."

EV=evidence
rm -rf "$EV/replay" && mkdir -p "$EV/replay"

run () {
  local label="$1"; shift
  echo "── $label"
  local out="$EV/replay/$label"
  mkdir -p "$out"
  npx tsx src/cli.ts replay "$@" > "$out/console.txt" 2>&1
  local dir
  dir=$(ls -td runs/replay-* 2>/dev/null | head -1)
  [ -n "$dir" ] && cp -R "$dir"/. "$out/" 2>/dev/null
  grep -E '^STATUS|^OUTCOME|^CLASS' "$out/console.txt" | sed 's/^/    /'
}

CAP=member.read-savings-balance

run 01-success                 --capability $CAP --input memberId=100442
run 02-business-outcome-notfound --capability $CAP --input memberId=999999
run 03-business-outcome-permission-denied --capability $CAP --input memberId=100442 --fault permdenied
run 04-business-outcome-validation --capability $CAP --input memberId=100442 --fault validation
run 05-recovered-session-expiry --capability $CAP --input memberId=100442 --fault timeout
run 06-recovered-unexpected-dialog --capability $CAP --input memberId=100442 --fault dialog
run 07-recovered-transient-slowness --capability $CAP --input memberId=100442 --fault slow
run 08-failure-contract-violation --capability $CAP --input memberId=not-a-member-number

# The escalation scenario needs the operator console running; it is captured by
# scripts/capture-escalation.sh because it requires a human (or a curl standing in for
# one) to resolve the intervention.
echo "── 09-escalation-human-handoff: run ./scripts/capture-escalation.sh (needs the operator console)"

mkdir -p "$EV/artifacts"
cp -R artifacts/. "$EV/artifacts/"

echo
echo "Evidence written to $EV/"
