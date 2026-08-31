#!/bin/bash
# Send a Pushover notification.
#
# Adapted from the deed-parse project's deploy/notify_pushover.sh, which
# earned each of the behaviours below the hard way. The differences here: this
# runs on a Mac as an ordinary user rather than as root under systemd, so there
# is no journalctl fallback and no root-owned /etc path.
#
#   sh scripts/notify-pushover.sh --title "..." --message "..." [--priority N]
#                                 [--url URL] [--url-title TEXT] [--monospace]
#
# SECRETS. The token and user key go in via `curl --config -` (stdin), never on
# the command line: argv is world-readable through `ps`. They live in
#   ~/.config/tuning-garage/pushover.env      (chmod 600)
# containing PUSHOVER_TOKEN= and PUSHOVER_USER=, and they never pass through
# this repository. Override the path with TUNING_PUSHOVER_ENV.
#
# ABSENT CONFIG IS NOT AN ERROR. With no env file this no-ops with exit 0, so a
# fresh clone works before anyone has set up alerting.
#
# RETRIES. Pushover is explicit: a 4xx will not succeed however many times you
# repeat it, and retrying those earns a temporary IP block; a 5xx should be
# retried no sooner than 5 seconds later. Both honoured. A single attempt means
# one transient blip silently swallows the alert — the worst failure available
# to a script whose only job is to say something broke.
#
# SUCCESS IS IN THE BODY, NOT THE STATUS CODE. The API signals real success with
# {"status":1,...}. Trusting HTTP 2xx alone reports sends that never landed. The
# match is whitespace-tolerant on purpose: if Pushover ever pretty-prints its
# JSON, an exact match would turn every future alert into a false failure.

set -euo pipefail

ENV_FILE="${TUNING_PUSHOVER_ENV:-$HOME/.config/tuning-garage/pushover.env}"
# Overridable so the retry and success-detection logic can be tested against a
# stand-in API without sending real notifications.
API="${TUNING_PUSHOVER_API:-https://api.pushover.net/1/messages.json}"
MAX_ATTEMPTS=3
RETRY_SLEEP=6          # the API asks for no sooner than 5s; 6 has margin

TITLE=""; MESSAGE=""; PRIORITY_OVERRIDE=""; URL=""; URL_TITLE=""; MONOSPACE=""
RETRY_ARG=""; EXPIRE_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --title) TITLE="$2"; shift 2 ;;
    --message) MESSAGE="$2"; shift 2 ;;
    --priority) PRIORITY_OVERRIDE="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --url-title) URL_TITLE="$2"; shift 2 ;;
    --retry) RETRY_ARG="$2"; shift 2 ;;
    --expire) EXPIRE_ARG="$2"; shift 2 ;;
    --monospace) MONOSPACE=1; shift ;;
    *) echo "notify-pushover: unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$TITLE" ] || { echo "notify-pushover: --title is required" >&2; exit 2; }

if [ ! -f "$ENV_FILE" ]; then
  echo "notify-pushover: $ENV_FILE absent — not sending (\"$TITLE\")"
  exit 0
fi
# shellcheck source=/dev/null
source "$ENV_FILE"
if [ -z "${PUSHOVER_TOKEN:-}" ] || [ -z "${PUSHOVER_USER:-}" ]; then
  echo "notify-pushover: $ENV_FILE has no PUSHOVER_TOKEN/PUSHOVER_USER — not sending" >&2
  exit 1
fi

# Emergency (priority 2) repeats until acknowledged and REQUIRES both of these;
# without them the API rejects the message outright and the most important
# alert in the system is simply lost. Defaulted rather than left to callers.
EMERGENCY_RETRY="${RETRY_ARG:-${PUSHOVER_EMERGENCY_RETRY:-300}}"
EMERGENCY_EXPIRE="${EXPIRE_ARG:-${PUSHOVER_EMERGENCY_EXPIRE:-3600}}"
PRIORITY="${PRIORITY_OVERRIDE:-${PUSHOVER_PRIORITY:-0}}"

# The API caps title at 250 and message at 1024. Trim rather than let it reject
# the whole notification: a truncated alert is worth far more than none.
TITLE="$(printf '%s' "$TITLE" | cut -c1-250)"
BODY="${MESSAGE:-(no detail)} [$(hostname -s), $(date -u +%FT%TZ)]"
# cut -c can land mid-character; the API rejects invalid UTF-8.
BODY="$(printf '%s' "$BODY" | cut -c1-1024 | iconv -c -f UTF-8 -t UTF-8 2>/dev/null || printf '%s' "$BODY")"

CURL_ARGS=(
  --form-string "priority=${PRIORITY}"
  --form-string "title=${TITLE}"
  --form-string "message=${BODY}"
)
if [ "$PRIORITY" = "2" ]; then
  CURL_ARGS+=(--form-string "retry=${EMERGENCY_RETRY}" --form-string "expire=${EMERGENCY_EXPIRE}")
fi
[ -n "$MONOSPACE" ] && CURL_ARGS+=(--form-string "monospace=1")
[ -n "$URL" ] && CURL_ARGS+=(--form-string "url=${URL}")
[ -n "$URL_TITLE" ] && CURL_ARGS+=(--form-string "url_title=${URL_TITLE}")

attempt=1
while :; do
  set +e
  RESPONSE="$(
    printf 'form-string = "token=%s"\nform-string = "user=%s"\n' "${PUSHOVER_TOKEN}" "${PUSHOVER_USER}" \
      | curl -sS --max-time 15 --config - "${CURL_ARGS[@]}" -w '\n%{http_code}' "$API" 2>&1
  )"
  set -e
  HTTP_CODE="$(printf '%s' "$RESPONSE" | tail -n1)"
  PAYLOAD="$(printf '%s' "$RESPONSE" | sed '$d')"
  case "$HTTP_CODE" in ''|*[!0-9]*) HTTP_CODE="000" ;; esac   # DNS/TLS/timeout

  case "$HTTP_CODE" in
    2*)
      if printf '%s' "$PAYLOAD" | grep -Eq '"status"[[:space:]]*:[[:space:]]*1'; then
        echo "notify-pushover: sent (\"$TITLE\")"
        exit 0
      fi
      echo "notify-pushover: HTTP $HTTP_CODE but status != 1 — $PAYLOAD" >&2
      exit 1 ;;
    4*)
      echo "notify-pushover: PERMANENT failure, HTTP $HTTP_CODE, not retrying" >&2
      echo "notify-pushover: API said: $PAYLOAD" >&2
      [ "$HTTP_CODE" = "429" ] && echo "notify-pushover: 429 means the monthly message quota is exhausted" >&2
      exit 1 ;;
    *)
      if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
        echo "notify-pushover: giving up after $attempt attempt(s), last HTTP $HTTP_CODE" >&2
        echo "notify-pushover: last response: $PAYLOAD" >&2
        exit 1
      fi
      echo "notify-pushover: HTTP $HTTP_CODE — retrying in ${RETRY_SLEEP}s (attempt $attempt/$MAX_ATTEMPTS)" >&2
      sleep "$RETRY_SLEEP"; attempt=$((attempt + 1)) ;;
  esac
done
