#!/usr/bin/env bash
# usage: run-suite.sh <label>  (from the repo root; saves the report next to the Challenge's private/tests)
label="$1"; O="../../mega-dev/Lessons/week_3/3_4/challenge/private/tests"; sha=$(git rev-parse --short HEAD)
f="$O/${label}-${sha}.txt"
{ echo "# suite at commit $sha ($label), $(date -u +%Y-%m-%dT%H:%M:%SZ), tree clean: $([ -z "$(git status --porcelain --untracked-files=no)" ] && echo yes || echo no)"; npx playwright test --reporter=list 2>&1; echo "exit: $?"; } > "$f"
sed 's/\x1b\[[0-9;]*m//g' "$f" | grep -E "^\s+[0-9]+ (passed|failed|skipped|flaky)|^exit"
echo "failed:"; sed 's/\x1b\[[0-9;]*m//g' "$f" | grep -E "^\s+[0-9]+\) " | sed -E 's/.*› ([^›]+) ›/  \1 ›/' | sed 's/ ─*$//' | sort -u
echo "report: $f"
