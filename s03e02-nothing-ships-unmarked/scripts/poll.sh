#!/usr/bin/env bash
# Bounded poll (plan steps 2 and 11): run the course collector up to MAX times, WAIT s apart,
# until desk, chat and mail each report 0 new; stop at the first failure (non-200 -> exit 1).
# Usage: SCHED_API=<api url> scripts/poll.sh <first run number> [MAX=10] [WAIT=60]
# Run from a folder with private/session.txt, private/work/sched-prod (the tracker kit) and scripts/.
set -u
C="$(cygpath -m "$PWD")"; FIRST="$1"; MAX="${2:-10}"; WAIT="${3:-60}"
API="${SCHED_API:?set SCHED_API to the tracker API address}"
for ((i=0; i<MAX; i++)); do
  n=$((FIRST+i)); [ $i -gt 0 ] && sleep "$WAIT"
  echo "== run $n $(date -u +%FT%TZ)"
  out="$(cd private/work/sched-prod && FETCH_LOG_DIR="$C/private/api/run$n" SCHED_API="$API" \
        SCHED_SESSION="$(tr -d '\r\n' < "$C/private/session.txt")" \
        node --import "file:///$C/scripts/fetch-logger.mjs" collectors/all.mjs 2>&1)"; rc=$?
  echo "$out"; grep -h '"status"' "private/api/run$n"/*.meta.json | tr -d ' \n'; echo
  if cmp -s private/api/run1/01-api-backlog.body.json "private/api/run$n/01-api-backlog.body.json"; then echo "backlog: same as run 1"; else echo "backlog: CHANGED"; fi
  [ $rc -ne 0 ] && { echo "stop: collector failed (exit $rc)"; exit 1; }
  if echo "$out" | grep -qE '^(desk|chat|mail): [1-9]'; then continue; fi
  echo "stop: all channels 0 new at run $n"; exit 0
done
echo "stop: $MAX runs done, channels still dealing"; exit 2
