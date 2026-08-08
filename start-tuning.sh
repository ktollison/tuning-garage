#!/bin/sh
# Tuning Garage launcher (Mac). Run: ./start-tuning.sh
cd "$(dirname "$0")"

PORT="${PORT:-4590}"
URL="http://127.0.0.1:$PORT"
LABEL="com.tuninggarage.app"

echo "Pulling latest from GitHub..."
git pull --ff-only || echo "(pull failed - offline or local changes; the app will show sync status)"

open_when_ready() {
  (
    i=0
    while [ $i -lt 40 ]; do
      if curl -s -o /dev/null -m 1 "$URL/"; then break; fi
      i=$((i + 1)); sleep 1
    done
    open "$URL"
  ) &
}

# A server may already be up — usually the launchd agent, which keeps running
# across pulls and so can be serving code from before the pull. Compare what it
# reports against what is on disk before deciding what to do.
node scripts/version-check.mjs
case $? in
  0)
    echo "Already running and up to date - opening $URL"
    open "$URL"
    exit 0
    ;;
  1)
    echo "Restarting so the new code takes effect..."
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
      # managed by launchd: let it do the restart, or it would just respawn
      launchctl kickstart -k "gui/$(id -u)/$LABEL"
      open_when_ready
      i=0
      while [ $i -lt 20 ]; do
        node scripts/version-check.mjs --quiet && break
        i=$((i + 1)); sleep 1
      done
      node scripts/version-check.mjs
      exit 0
    fi
    # started by hand: stop it, then fall through and start in the foreground
    pid=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null)
    [ -n "$pid" ] && kill "$pid" 2>/dev/null && sleep 1
    ;;
  3)
    echo "Port $PORT is in use by something that is not this app."
    echo "Find it with:  lsof -nP -iTCP:$PORT -sTCP:LISTEN"
    echo "Or use another port:  PORT=4700 ./start-tuning.sh"
    exit 1
    ;;
esac

open_when_ready
echo "Starting Tuning Garage on $URL - Ctrl-C to stop."
exec node app/server.mjs
