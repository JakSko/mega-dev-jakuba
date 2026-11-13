#!/bin/sh
# First start: make the working copy on the volume from the seed, as its own git repo.
set -e
DATA="${DATA_DIR:-/data}"
WORK="${WORK_DIR:-$DATA/work}"
mkdir -p "$DATA"
if [ ! -d "$WORK/.git" ]; then
  mkdir -p "$WORK"
  cp -a /seed/api/. "$WORK/"
  mkdir -p "$WORK/.runner"
  chown -R coder:coder "$WORK"
  cd "$WORK"
  setpriv --reuid 1001 --regid 1001 --clear-groups env HOME=/home/coder sh -c '
    git init -q -b main &&
    git config user.name "runner agent" && git config user.email "agent@invalid.example" &&
    echo ".runner/" >> .git/info/exclude &&
    git add -A && git commit -q -m "Base: the API as deployed before the round"'
  echo "{\"kind\":\"seeded\",\"work\":\"$WORK\"}"
fi
mkdir -p /home/coder/.codex && chown -R coder:coder /home/coder
if [ -n "$PREFLIGHT" ]; then
  # One-off checks on this host, printed to the log: wrangler can bundle, and the real CLI can
  # decide, build (as user coder, bare environment) and review the dev issues named in PREFLIGHT.
  echo '{"kind":"preflight","step":"wrangler dry run"}'
  (cd "$WORK" && npx wrangler deploy --env production --dry-run 2>&1 | tail -6) || echo '{"kind":"preflight","wrangler":"FAILED"}'
  echo '{"kind":"preflight","step":"codex real check"}'
  (cd /app/runner && setpriv --reuid 1001 --regid 1001 --clear-groups env -i PATH="$PATH" HOME=/home/coder CODEX_HOME=/home/coder/.codex LANG=C.UTF-8 \
     OPENAI_API_KEY="$OPENAI_API_KEY" API_DIR=/seed/api MODEL_BUILD="$MODEL_BUILD" MODEL_REVIEW="$MODEL_REVIEW" CODEX_BUILD_SANDBOX="$CODEX_BUILD_SANDBOX" TMPDIR=/tmp \
     node scripts/real-check.mjs - codex --build "$PREFLIGHT" 2>&1) || echo '{"kind":"preflight","codex":"FAILED"}'
  echo '{"kind":"preflight","step":"done"}'
fi
if [ -n "$PREFLIGHT_ROUND" ] && [ ! -f "$DATA/preflight-round/round-report.json" ]; then
  # One rehearsal of a whole round on this host, once: the real runner as it runs in the round
  # (root, model-written code as user coder), the real model, a fake tracker, feed and live address.
  echo '{"kind":"preflight","step":"round rehearsal"}'
  (cd /app/runner && ROUND_LIMIT_MIN=15 API_DIR=/seed/api node scripts/real-round.mjs - codex scripts/dev-issues.json 5 "$DATA/preflight-round" 2>&1 | tail -40) || echo '{"kind":"preflight","round":"FAILED"}'
  echo '{"kind":"preflight","step":"round rehearsal done"}'
fi
if [ -n "$PREFLIGHT_ROUND" ] && [ -f "$DATA/preflight-round/state.json" ]; then
  # Show what the rehearsal left on the volume: the ship line per issue and the gate events.
  node -e 'const s=require(process.argv[1]); for (const i of Object.values(s.issues)) console.log(JSON.stringify({kind:"rehearsal-line",n:i.n,phase:i.phase,line:i.line,verb:i.decision&&i.decision.verb})); console.log(JSON.stringify({kind:"rehearsal-calls",modelCalls:s.modelCalls}))' "$DATA/preflight-round/state.json" || true
  grep -E '"kind":"(gates|review|deploy|rollback|process-failed|live-check)"' "$DATA/preflight-round/action.log" | cut -c1-300 | tail -30 || true
fi
cd /app/runner
echo "{\"kind\":\"start-line\",\"cmd\":\"node src/main.mjs\",\"node\":\"$(node --version)\",\"codex\":\"$(codex --version 2>&1)\"}"
exec node src/main.mjs
