#!/usr/bin/env bash
# The world audit, a CI gate: builds the game world twice in headless Chrome (fresh profiles, no cache) and checks it against
# ops/audit-rules.json: placement (no building on a road, no wall across one, no kerb mid-road), doors (clear, on the ground, dry),
# entrances, window coverage, and determinism (both builds must have the same world fingerprint). Exit 1 on any failure.
# Usage: ops/audit.sh            (GAME_DIR, CHROME and BUDGET_MS can be set)
set -euo pipefail
cd "$(dirname "$0")/.."
GAME="${GAME_DIR:-../giantwood-scouts}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || { echo "audit: Chrome not found at $CHROME (set CHROME)" >&2; exit 2; }
TMP=$(mktemp -d); PORT=$((20000 + RANDOM % 20000))
python3 -m http.server "$PORT" --bind 127.0.0.1 -d "$GAME" >/dev/null 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true; rm -rf "$TMP"' EXIT
sleep 1
URL="http://127.0.0.1:$PORT/index.html?server=http://127.0.0.1:9&nocache&audit"
echo "audit: building the world twice (headless)…"
PIDS=()
for i in 1 2; do
  "$CHROME" --headless=new --disable-gpu-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader --no-first-run --mute-audio \
    --user-data-dir="$TMP/p$i" --virtual-time-budget="${BUDGET_MS:-150000}" --window-size=800,600 --dump-dom "$URL" > "$TMP/dom$i.html" 2>/dev/null &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p" || true; done
python3 ops/audit_check.py "$TMP/dom1.html" "$TMP/dom2.html" ops/audit-rules.json
