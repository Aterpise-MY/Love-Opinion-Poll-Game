#!/usr/bin/env bash
# End-to-end check of the API surface, including both 409 paths, and then of
# offline mode: on in a lobby, votes refused, off again, votes taken.
#
#   ./scripts/smoke.sh                          boots a local server on :8522
#   BASE=http://localhost:8520 ADMIN_KEY=... ./scripts/smoke.sh
#
# Against a server that is already running it uses whatever deck that server
# loaded, so the EXPIRED check waits out the real countdown — start the
# container with DECK_FILE=/app/deck.test.json to get 2-second questions.
# Booting its own server, it uses deck.test.json (2s).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_KEY="${ADMIN_KEY:-dev}"
SERVER_PID=""

if [[ -z "${BASE:-}" ]]; then
  BASE="http://localhost:8522"
  PORT=8522 ADMIN_KEY="$ADMIN_KEY" DECK_FILE="$ROOT/backend/deck.test.json" \
    node "$ROOT/backend/server.js" >/tmp/love-opinion-poll-smoke.log 2>&1 &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

  up=""
  for _ in $(seq 1 40); do
    if curl -sf "$BASE/health" >/dev/null 2>&1; then up=1; break; fi
    sleep 0.1
  done
  if [[ -z "$up" ]]; then
    echo "server failed to start; log:" >&2
    cat /tmp/love-opinion-poll-smoke.log >&2
    exit 1
  fi
fi
BASE="${BASE%/}"

pass=0
fail=0

# check <label> <expected-status> <expected-substring> <curl args...>
check() {
  local label="$1" want_status="$2" want_body="$3"
  shift 3
  local out status body
  out="$(curl -s -w $'\n%{http_code}' "$@")"
  status="${out##*$'\n'}"
  body="${out%$'\n'*}"

  if [[ "$status" == "$want_status" && "$body" == *"$want_body"* ]]; then
    printf '  ok    %-46s %s\n' "$label" "$status"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-46s got %s %s (wanted %s ~ %s)\n' \
      "$label" "$status" "$body" "$want_status" "$want_body"
    fail=$((fail + 1))
  fi
}

admin() { check "admin $1" "${2:-200}" "${3:-\"phase\"}" -X POST "$BASE/admin" \
  -H 'content-type: application/json' -d "{\"key\":\"$ADMIN_KEY\",\"action\":\"$1\"}"; }

vote() { check "vote $1 -> $3" "${4:-200}" "${5:-\"ok\":true}" -X POST "$BASE/vote" \
  -H 'content-type: application/json' -d "{\"voterId\":\"$1\",\"qIndex\":$2,\"choice\":\"$3\"}"; }

echo "smoke: $BASE"

admin RESET
check "state is LOBBY, tally hidden" 200 '"tally":null' "$BASE/state"

check "join"           200 '"created":true'  -X POST "$BASE/join" -H 'content-type: application/json' -d '{"voterId":"smoke-voter-1"}'
check "join is idempotent" 200 '"created":false' -X POST "$BASE/join" -H 'content-type: application/json' -d '{"voterId":"smoke-voter-1"}'

vote smoke-voter-1 0 a 409 WRONG_PHASE
check "admin needs the key" 401 UNAUTHORIZED -X POST "$BASE/admin" \
  -H 'content-type: application/json' -d '{"key":"wrong","action":"START"}'

admin START
vote smoke-voter-1 0 a
vote smoke-voter-1 0 b 409 ALREADY_VOTED
vote smoke-voter-2 0 b
# `"tally":{`, not `"tally"`: the bare key is in every response, null or not, so
# matching it alone could never fail.
check "room sees the live tally while voting" 200 '"tally":{' "$BASE/state"
check "operator sees the live tally"          200 '"tally":{' "$BASE/state?k=$ADMIN_KEY"

# Wait out the countdown AND the late-vote grace, then confirm votes bounce.
# Keep GRACE_S >= backend/game.js LATE_VOTE_GRACE_MS or this check silently
# starts passing votes it is supposed to reject.
GRACE_S=5
ends_at="$(curl -s "$BASE/state" | sed -n 's/.*"phaseEndsAt":\([0-9]*\).*/\1/p')"
now_ms="$(curl -s "$BASE/state" | sed -n 's/.*"serverNow":\([0-9]*\).*/\1/p')"
wait_s="$(awk -v e="$ends_at" -v n="$now_ms" -v g="$GRACE_S" \
  'BEGIN { printf "%.1f", (e - n) / 1000 + g + 2 }')"
echo "  ...waiting ${wait_s}s for the countdown to expire"
sleep "$wait_s"

vote smoke-voter-3 0 a 409 EXPIRED
admin REVEAL
check "reveal exposes the split" 200 '"tally":{' "$BASE/state"
admin BACK
# REVEAL was pressed on an expired VOTING, never LOCKED, so that is where one
# step back lands. Asserted on the phase itself: the tally is public in both.
check "back returns to VOTING" 200 '"phase":"VOTING"' "$BASE/state"
admin REVEAL
admin NEXT

# Offline mode. The run above ends in the lobby before question two, which is
# where the switch is allowed — so this starts from there, whatever deck the
# server has loaded, and puts the server back in an online lobby when it is
# done.
admin OFFLINE_ON
check "state says offline" 200 '"offline":true' "$BASE/state"
admin OFFLINE_ON # twice changes nothing
admin START
vote smoke-voter-4 1 a 409 OFFLINE
# The switch is a lobby-only one: not under an open question.
admin OFFLINE_OFF 409 WRONG_PHASE
admin LOCK
# Straight on from LOCKED, with no reveal. Online this is a 409.
admin NEXT
admin RESET
check "offline mode survives RESET" 200 '"offline":true' "$BASE/state"
admin OFFLINE_OFF
check "online again" 200 '"offline":false' "$BASE/state"
admin START
vote smoke-voter-4 0 a
admin RESET

echo
if ((fail > 0)); then
  echo "FAILED: $fail failed, $pass passed"
  [[ -n "$SERVER_PID" ]] && echo "server log: /tmp/love-opinion-poll-smoke.log"
  exit 1
fi
echo "OK: $pass checks passed"
