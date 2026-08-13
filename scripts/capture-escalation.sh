#!/usr/bin/env bash
# Captures the human-escalation scenario end to end.
#
# Needs the target app AND the operator console running:
#   npm run target-app     (shell 1)
#   npm run operator       (shell 2)
#
# A curl stands in for the operator clicking "Resume". Doing it by hand in the browser
# at http://localhost:3200 exercises exactly the same path.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=evidence/replay/09-escalation-human-handoff
rm -rf "$OUT" runs/interventions && mkdir -p "$OUT"

npx tsx src/cli.ts replay --capability member.open-subaccount \
  --input memberId=100442 --input accountType=S2 \
  --escalation-timeout 120000 > "$OUT/console.txt" 2>&1 &
ENGINE=$!

# Wait for the engine to reach the irreversible step and file its request.
for _ in $(seq 1 40); do
  REQ=$(ls runs/interventions/*.json 2>/dev/null | head -1)
  [ -n "$REQ" ] && break
  sleep 1
done
[ -z "${REQ:-}" ] && { echo "no intervention was raised"; kill $ENGINE 2>/dev/null; exit 1; }

ID=$(basename "$REQ" .json)
echo "intervention raised: $ID"
curl -s "http://localhost:3200/request/$ID" > "$OUT/operator-console.html"

curl -s -X POST -o /dev/null \
  --data-urlencode "action=resume" \
  --data-urlencode "note=Verified member eligibility in the core; approved opening the S2 share." \
  "http://localhost:3200/resolve/$ID"

wait $ENGINE
cp "runs/interventions/$ID.json" "$OUT/intervention-request.json"
DIR=$(ls -td runs/replay-* | head -1) && cp -R "$DIR"/. "$OUT/"
grep -E '^STATUS|^HUMAN' "$OUT/console.txt" | sed 's/^/    /'
