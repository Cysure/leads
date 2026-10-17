#!/usr/bin/env bash
# Keeps Google reviews (maps.mjs) and screenshots + CTA analysis (scan.mjs) working through the leads in current
# rank order, 300 at a time, re-reading the ranking between rounds so newly scanned sites slot in by priority.
# Stops when both have nothing left and the HTTP pass has finished. Needs the dashboard server on :6300.
cd "$(dirname "$0")/.."
while true; do
  curl -s --compressed http://localhost:6300/api/order -o data/order.json || { sleep 60; continue; }
  node src/maps.mjs --from data/order.json --concurrency 5 --limit 300 > data/maps.log 2>&1 &
  node src/scan.mjs --from data/order.json --concurrency 6 --limit 300 > data/scan.log 2>&1
  wait
  maps_left=$(grep -o "[0-9]* to look up" data/maps.log | head -1 | cut -d' ' -f1)
  scan_left=$(grep -o "[0-9]* to go" data/scan.log | head -1 | cut -d' ' -f1)
  echo "$(date +%H:%M) round done: reviews left $maps_left, screenshots left $scan_left"
  # Hosted dashboard: push the new results after every round (needs .env, see .env.example).
  if grep -q "^DEALFLOW_DATABASE_URL=." .env 2>/dev/null; then node src/sync.mjs > data/sync.log 2>&1 && tail -1 data/sync.log; fi
  if [ "${maps_left:-1}" = "0" ] && [ "${scan_left:-1}" = "0" ] && grep -q "done:" data/http.log; then echo "all enriched"; break; fi
done
