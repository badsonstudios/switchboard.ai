#!/usr/bin/env bash
# S-04 probe: start the tailer, then run a real session in the fixture that
# does a Write + a Bash call; the tailer must derive status/tokens/tools/lag
# purely from the transcript.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_WIN="$(cygpath -m "$REPO/.claude/work_files/s04")"
OUT_U="$(cygpath -u "$OUT_WIN")"
FIX_WIN="C:/tmp/s04-project"
FIX_U="$(cygpath -u "$FIX_WIN")"

rm -rf "$OUT_U"; mkdir -p "$OUT_U" "$FIX_U"
echo "fixture" > "$FIX_U/README.md"

node "$(cygpath -m "$REPO/spike/s04")/tail-transcript.js" "$FIX_WIN" "$OUT_WIN" --follow-ms 90000 \
  > "$OUT_U/tailer-stdout.txt" 2>&1 &
TPID=$!
trap 'kill $TPID 2>/dev/null || true' EXIT
sleep 2

(cd "$FIX_U" && claude -p "Create the file s04-note.txt containing 'transcript probe' using the Write tool, then run this exact command with the Bash tool: echo s04-bash-probe. Then reply DONE." \
  --allowedTools "Write Bash" ) || echo "claude exit: $?"

wait $TPID || true
echo "--- tailer stdout (tail) ---"
tail -5 "$OUT_U/tailer-stdout.txt"
echo "--- summary.json ---"
cat "$OUT_U/summary.json" 2>/dev/null || echo "(none)"
