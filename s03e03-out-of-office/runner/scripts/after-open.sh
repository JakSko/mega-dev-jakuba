#!/bin/sh
# Right after the round opens: hand the round's addresses and token to the Worker and the host.
# Usage: sh runner/scripts/after-open.sh <round-config.json> <cloudflare token file>
# round-config.json: { "trackerUrl": "...", "trackerToken": "...", "feedUrl": "..." }
# Values go through stdin only. Nothing secret is printed. Run from this folder.
set -e
CFG="$1"; CFT="$2"
get() { node -e "const c=require(process.argv[1]); const v=c[process.argv[2]]; if(!v){console.error('missing '+process.argv[2]); process.exit(1)}; process.stdout.write(String(v))" "$CFG" "$1"; }
for k in trackerUrl trackerToken feedUrl; do get "$k" >/dev/null; done
echo "1/5 FEED_URL secret on the Worker"
( cd example-api && get feedUrl | CLOUDFLARE_API_TOKEN="$(tr -d '\r\n' < "$CFT")" npx wrangler secret put FEED_URL --env production 2>&1 | grep -E "Success|Created|Uploaded|error|Error" | head -3 )
echo "2/5 tracker and feed values on the host"
get trackerUrl   | railway variable set TRACKER_URL   --stdin --service agent --skip-deploys --json >/dev/null
get trackerToken | railway variable set TRACKER_TOKEN --stdin --service agent --skip-deploys --json >/dev/null
get feedUrl      | railway variable set FEED_URL      --stdin --service agent --skip-deploys --json >/dev/null
echo "3/5 no rehearsal at the next start"
railway variable delete PREFLIGHT_ROUND --service agent --json >/dev/null 2>&1 || true
railway variable delete PREFLIGHT --service agent --json >/dev/null 2>&1 || true
echo "4/5 restart the host with the new values"
railway redeploy --service agent --yes 2>&1 | tail -1
echo "5/5 the live address from outside"
sleep 8
curl -sS -m 20 -w '\nHTTP %{http_code} %{content_type}\n' "${LIVE_URL:?set LIVE_URL to the live https address}/incidents" | cut -c1-300
date -u +%Y-%m-%dT%H:%M:%SZ
