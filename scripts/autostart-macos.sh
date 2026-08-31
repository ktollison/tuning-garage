#!/bin/sh
# Keep the Tuning Garage app running via launchd (macOS).
#
#   sh scripts/autostart-macos.sh install     start now + at every login
#   sh scripts/autostart-macos.sh status      is it loaded and answering?
#   sh scripts/autostart-macos.sh restart     reload after pulling changes
#   sh scripts/autostart-macos.sh uninstall   stop and remove
#
# The agent runs as you, not as root, and the server binds 127.0.0.1 only —
# nothing is exposed to the network. Logs land in logs/ (gitignored).

set -e

LABEL="com.tuninggarage.app"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-4590}"
TARGET="gui/$(id -u)"

# Resolve node to an absolute path — launchd runs with a minimal PATH that
# does not include /usr/local/bin or Homebrew, so "node" alone will not work.
NODE="${NODE:-$(command -v node || true)}"
[ -x "$NODE" ] || { echo "node not found on PATH. Install Node 18+ or set NODE=/path/to/node."; exit 1; }

cmd="${1:-install}"

case "$cmd" in
install)
  mkdir -p "$HOME/Library/LaunchAgents" "$REPO/logs"

  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>$REPO/app/server.mjs</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$REPO</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>$PORT</string>
        <key>TUNING_REPO</key>
        <string>$REPO</string>
    </dict>

    <!-- Start at login and relaunch if it ever exits -->
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>

    <!-- Don't hammer relaunches if it fails immediately -->
    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>$REPO/logs/app.out.log</string>
    <key>StandardErrorPath</key>
    <string>$REPO/logs/app.err.log</string>
</dict>
</plist>
PLISTEOF

  # bootout first so "install" is safe to re-run after an edit. launchd does not
  # finish the unload synchronously, and bootstrapping into a label it is still
  # tearing down fails with "Bootstrap failed: 5: Input/output error" — which
  # leaves NOTHING running, because the bootout did succeed. Wait for the label
  # to actually disappear, then retry once.
  launchctl bootout "$TARGET/$LABEL" 2>/dev/null || true
  i=0
  while launchctl print "$TARGET/$LABEL" >/dev/null 2>&1 && [ $i -lt 10 ]; do sleep 0.5; i=$((i + 1)); done
  if ! launchctl bootstrap "$TARGET" "$PLIST" 2>/dev/null; then
    sleep 2
    launchctl bootstrap "$TARGET" "$PLIST"
  fi
  launchctl enable "$TARGET/$LABEL" 2>/dev/null || true

  echo "Installed $LABEL"
  echo "  node   $NODE"
  echo "  repo   $REPO"
  echo "  url    http://localhost:$PORT"
  sleep 1
  sh "$0" status
  ;;

status)
  if launchctl print "$TARGET/$LABEL" >/dev/null 2>&1; then
    pid=$(launchctl print "$TARGET/$LABEL" | awk '/^\tpid = /{print $3}')
    echo "agent loaded${pid:+, pid $pid}"
  else
    echo "agent NOT loaded — run: sh scripts/autostart-macos.sh install"
  fi
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:$PORT/api/state" || echo 000)
  if [ "$code" = "200" ]; then
    echo "server answering on http://localhost:$PORT (HTTP $code)"
  else
    echo "server NOT answering on port $PORT (HTTP $code) — check logs/app.err.log"
  fi
  # A loaded agent answering on the port is not the same as a CURRENT one: the
  # process outlives every pull, so it can serve last week's build while both
  # checks above stay green. That is exactly how it went unnoticed.
  # `|| vc=$?` matters: this script runs under `set -e`, so a bare non-zero
  # command would abort before the hint below could print.
  vc=0
  PORT="$PORT" node "$REPO/scripts/version-check.mjs" || vc=$?
  [ "$vc" -eq 1 ] && echo "  fix:  sh scripts/autostart-macos.sh restart"
  ;;

restart)
  launchctl kickstart -k "$TARGET/$LABEL"
  echo "restarted"
  # wait for the new process to answer before reporting, so the version shown
  # is the one now serving rather than whatever was still winding down
  i=0
  while [ $i -lt 20 ]; do
    PORT="$PORT" node "$REPO/scripts/version-check.mjs" --quiet && break
    i=$((i + 1)); sleep 1
  done
  sh "$0" status
  ;;

uninstall)
  launchctl bootout "$TARGET/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL. Logs left in $REPO/logs/."
  ;;

watch-install)
  # A second agent, on a timer rather than KeepAlive: it runs, alerts, exits.
  mkdir -p "$HOME/Library/LaunchAgents" "$REPO/logs"
  WLABEL="com.tuninggarage.watch"
  WPLIST="$HOME/Library/LaunchAgents/$WLABEL.plist"
  INTERVAL="${WATCH_INTERVAL:-900}"
  cat > "$WPLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$WLABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>$REPO/scripts/watch-submissions.mjs</string>
    </array>
    <key>WorkingDirectory</key><string>$REPO</string>
    <!-- gh lives in /usr/local/bin or /opt/homebrew/bin; launchd's PATH has neither -->
    <key>EnvironmentVariables</key>
    <dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
    <key>StartInterval</key><integer>$INTERVAL</integer>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>$REPO/logs/watch.out.log</string>
    <key>StandardErrorPath</key><string>$REPO/logs/watch.err.log</string>
</dict>
</plist>
PLISTEOF
  launchctl bootout "$TARGET/$WLABEL" 2>/dev/null || true
  launchctl bootstrap "$TARGET" "$WPLIST"
  echo "Installed $WLABEL — polling every ${INTERVAL}s"
  echo "  alerts need $HOME/.config/tuning-garage/pushover.env (chmod 600)"
  echo "  without it the poller runs and quietly sends nothing"
  ;;

watch-uninstall)
  launchctl bootout "$TARGET/com.tuninggarage.watch" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.tuninggarage.watch.plist"
  echo "Removed com.tuninggarage.watch"
  ;;

*)
  echo "usage: sh scripts/autostart-macos.sh [install|status|restart|uninstall|watch-install|watch-uninstall]"
  exit 1
  ;;
esac
