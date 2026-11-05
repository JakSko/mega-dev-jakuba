#!/bin/sh
# POST a JSON body file to the challenge API with curl and append request + reply to the log, exactly.
# usage: post.sh <body.json> <note>
URL="https://hq.mega.dev/challenges/where-the-story-begins/api"
LOG="${LOG:-log.md}"  # the Challenge log, in the working folder
BODY="$1"; NOTE="$2"
OUT=$(mktemp)
STATUS=$(curl -sS -o "$OUT" -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary @"$BODY" "$URL")
{
  printf '\n## %s POST %s\n\n%s\n\nRequest body:\n\n```json\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$URL" "$NOTE"
  cat "$BODY"
  printf '\n```\n\nReply (HTTP %s):\n\n```\n' "$STATUS"
  cat "$OUT"
  printf '\n```\n'
} >> "$LOG"
echo "HTTP $STATUS"
cat "$OUT"
rm -f "$OUT"
