#!/bin/sh
# Regenerate the user-guide screenshots from the demo repo.
#
#   node scripts/make-demo.mjs /tmp/tuning-demo
#   TUNING_REPO=/tmp/tuning-demo node app/server.mjs &
#   sh scripts/make-screenshots.sh
#
# Uses headless Chromium (Edge or Chrome, whichever is installed) so the images
# are captured from the real app, and can be regenerated after any UI change.
# Every shot comes from the DEMO repo — never from personal data.

set -e
BASE="${BASE:-http://127.0.0.1:4590}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/guide/images"
V="2002-camaro-ls1"
STOCK="vehicles/$V/tunes/stock/stock_2026-03-04_full-read.bin"
REV="vehicles/$V/tunes/v001_2026-03-09_maf-cal-pass1.bin"
CRUISE="vehicles/$V/datalogs/2026-03-06_v000_cruise-ltft.csv"
WOT="vehicles/$V/datalogs/2026-03-12_v001_wot-pull.csv"

for c in "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
         "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
         "$(command -v chromium || true)"; do
  [ -x "$c" ] && BROWSER="$c" && break
done
[ -z "$BROWSER" ] && { echo "No Chromium-based browser found for headless capture."; exit 1; }

mkdir -p "$OUT"
shot() { # shot <name> <height> <url-suffix>
  "$BROWSER" --headless=new --disable-gpu --hide-scrollbars \
    --window-size=1240,"$2" --virtual-time-budget=9000 \
    --screenshot="$OUT/$1.png" "$BASE/$3" >/dev/null 2>&1
  printf "  %-26s %s\n" "$1.png" "$(du -h "$OUT/$1.png" | cut -f1)"
}

echo "Capturing to $OUT"
shot garage              1000 "?noscroll=1#garage"
shot overview            1250 "?noscroll=1#overview"
shot tunes               1150 "?noscroll=1#tunes"
shot bin-analysis        1250 "?noscroll=1&bin=$STOCK#tunes"
shot bin-compare         1250 "?noscroll=1&compare=$STOCK|$REV#tunes"
shot preflight-checklist 1450 "?noscroll=1&flash=v001#tunes"
shot trim-analysis       1500 "?noscroll=1&analyze=$CRUISE#datalogs"
shot wot-analysis        1900 "?noscroll=1&analyze=$WOT#datalogs"
shot timeline            1100 "?noscroll=1#timeline"
shot progression         1200 "?noscroll=1#progression"
shot user-math           1200 "?noscroll=1#usermath"
shot scanner             1000 "?noscroll=1#scanner"
shot library             1000 "?noscroll=1#library"
echo "Done."
