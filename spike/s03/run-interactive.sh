#!/usr/bin/env bash
# S-03 interactive scenarios: drive a real claude TUI via node-pty (Electron
# ABI => run pty-drive.js under electron.exe with ELECTRON_RUN_AS_NODE=1).
#   bash run-interactive.sh ask    # hook answers "ask" -> TUI prompt expected
#   bash run-interactive.sh hang   # hook hangs -> does TUI fallback engage?
set -euo pipefail

SC="${1:?usage: run-interactive.sh <allow|deny|ask|hang>}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
S03_WIN="$(cygpath -m "$REPO/spike/s03")"
OUT_U="$(cygpath -u "$(cygpath -m "$REPO/.claude/work_files/s03")")/live-$SC"
OUT_WIN="$(cygpath -m "$OUT_U")"
FIX_WIN="C:/tmp/s03-project"
FIX_U="$(cygpath -u "$FIX_WIN")"
ELECTRON="$REPO/spike/node_modules/electron/dist/electron.exe"

rm -rf "$OUT_U"; mkdir -p "$OUT_U"
rm -f "$FIX_U/live-$SC.txt"

DEC="$SC"; DELAY=1000
[ "$SC" = "ask" ] && DEC="ask"
[ "$SC" = "hang" ] && { DEC="hang"; DELAY=0; }

node "$S03_WIN/listener.js" "$OUT_WIN" "$DEC" "$DELAY" &
LPID=$!
trap 'kill $LPID 2>/dev/null || true' EXIT
sleep 1

port="$(node -p "JSON.parse(require('fs').readFileSync('$OUT_WIN/listener.json','utf8')).port")"
token="$(node -p "JSON.parse(require('fs').readFileSync('$OUT_WIN/listener.json','utf8')).token")"
cat > "$OUT_U/settings.json" <<EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", "command": "node $S03_WIN/hook-forward.js $port $token $OUT_WIN/hook.log" } ]
      }
    ]
  }
}
EOF

ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$S03_WIN/pty-drive.js" \
  "$SC" "$OUT_WIN/settings.json" "$FIX_WIN" "$OUT_WIN" \
  && RC=0 || RC=$?

echo "--- result.json ---"; cat "$OUT_U/result.json" 2>/dev/null || echo "(none)"
echo "--- hook log ---"; cat "$OUT_U/hook.log" 2>/dev/null || echo "(none)"
echo "--- listener log ---"; cat "$OUT_U/listener.log" 2>/dev/null || echo "(none)"
exit $RC
