#!/usr/bin/env bash
# S-06 probe: status transitions driven ONLY by hook events through a real
# work -> needs-permission -> approve -> subagent -> done cycle in the
# interactive TUI. Reuses s03/hook-forward.js (blocking forward is fine: the
# status listener acks instantly) and s03/pty-drive.js scenario "status".
#
# Timing question answered by correlating ISO timestamps:
#   pty events.log  "permission-prompt matched" = TUI showed the prompt
#   status.log      Notification EVENT line     = hook told us
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
S03_WIN="$(cygpath -m "$REPO/spike/s03")"
S06_WIN="$(cygpath -m "$REPO/spike/s06")"
OUT_U="$(cygpath -u "$(cygpath -m "$REPO/.claude/work_files/s06")")"
OUT_WIN="$(cygpath -m "$OUT_U")"
FIX_WIN="C:/tmp/s06-project"
FIX_U="$(cygpath -u "$FIX_WIN")"
ELECTRON="$REPO/spike/node_modules/electron/dist/electron.exe"

rm -rf "$OUT_U"; mkdir -p "$OUT_U" "$FIX_U"
echo "fixture" > "$FIX_U/README.md"
rm -f "$FIX_U/live-status.txt"

node "$S06_WIN/status-listener.js" "$OUT_WIN" &
LPID=$!
trap 'kill $LPID 2>/dev/null || true' EXIT
sleep 1

port="$(node -p "JSON.parse(require('fs').readFileSync('$OUT_WIN/listener.json','utf8')).port")"
token="$(node -p "JSON.parse(require('fs').readFileSync('$OUT_WIN/listener.json','utf8')).token")"
FWD="node $S03_WIN/hook-forward.js $port $token $OUT_WIN/hook.log"
cat > "$OUT_U/settings.json" <<EOF
{
  "hooks": {
    "SessionStart":     [ { "hooks": [ { "type": "command", "timeout": 10, "command": "$FWD" } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "timeout": 10, "command": "$FWD" } ] } ],
    "Notification":     [ { "hooks": [ { "type": "command", "timeout": 10, "command": "$FWD" } ] } ],
    "SubagentStop":     [ { "hooks": [ { "type": "command", "timeout": 10, "command": "$FWD" } ] } ],
    "Stop":             [ { "hooks": [ { "type": "command", "timeout": 10, "command": "$FWD" } ] } ]
  }
}
EOF

ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$S03_WIN/pty-drive.js" \
  status "$OUT_WIN/settings.json" "$FIX_WIN" "$OUT_WIN" \
  && RC=0 || RC=$?

echo "--- status transitions ---"
cat "$OUT_U/transitions.json" 2>/dev/null || echo "(none)"
echo "--- status log ---"
cat "$OUT_U/status.log" 2>/dev/null | head -40
echo "--- pty events (ISO-stamped) ---"
cat "$OUT_U/events.log" 2>/dev/null
exit $RC
