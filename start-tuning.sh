#!/bin/sh
# Tuning Garage launcher (Mac). Run: ./start-tuning.sh
cd "$(dirname "$0")"

echo "Pulling latest from GitHub..."
git pull --ff-only || echo "(pull failed - offline or local changes; the app will show sync status)"

# Wait for the server to accept a connection, then open the browser.
# Polls 127.0.0.1 (the address the server actually binds) rather than localhost.
(
  i=0
  while [ $i -lt 40 ]; do
    if curl -s -o /dev/null -m 1 http://127.0.0.1:4590/; then break; fi
    i=$((i + 1)); sleep 1
  done
  open "http://127.0.0.1:4590"
) &

echo "Starting Tuning Garage on http://127.0.0.1:4590 - Ctrl-C to stop."
exec node app/server.mjs
