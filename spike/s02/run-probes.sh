#!/usr/bin/env bash
# S-02 probes A+B: does `claude --settings <file>` fire our hooks in a project
# whose .claude/ we never touch, and do the project's own settings still apply?
#
# Layout:
#   fixture project  C:/tmp/s02-project          — has its OWN .claude/settings.json
#                                                  (the "user's" hook → markers-user.log)
#   injected file    .claude/work_files/s02/injected-settings.json (generated, abs paths)
#   marker logs      .claude/work_files/s02/     — written by the hooks themselves
#
# PASS = both marker logs gain lines AND the fixture .claude/ is byte-identical
# before vs after.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
S02_WIN="$(cygpath -m "$REPO/spike/s02")"
OUT_WIN="$(cygpath -m "$REPO/.claude/work_files/s02")"
OUT_U="$(cygpath -u "$OUT_WIN")"
FIX_WIN="C:/tmp/s02-project"
FIX_U="$(cygpath -u "$FIX_WIN")"

MARKER="$S02_WIN/hook-marker.js"
INJ_LOG="$OUT_WIN/markers-injected.log"
USER_LOG="$OUT_WIN/markers-user.log"

echo "== setup =="
rm -rf "$FIX_U"
mkdir -p "$FIX_U/.claude"
mkdir -p "$OUT_U"
rm -f "$OUT_U/markers-injected.log" "$OUT_U/markers-user.log"

# The fixture's own settings — stands in for a user's pre-existing config.
cat > "$FIX_U/.claude/settings.json" <<EOF
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node $MARKER user $USER_LOG" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node $MARKER user $USER_LOG" } ] }
    ]
  }
}
EOF
echo "fixture README" > "$FIX_U/README.md"

# Our injected settings — generated into git-ignored work_files (absolute
# machine-specific paths; committing it would ship a stale artifact).
cat > "$OUT_U/injected-settings.json" <<EOF
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node $MARKER injected $INJ_LOG" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node $MARKER injected $INJ_LOG" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node $MARKER injected $INJ_LOG" } ] }
    ]
  }
}
EOF

snapshot() { (cd "$FIX_U" && find .claude -type f | sort | xargs sha1sum); }

echo "== probe A+B: headless run with --settings <file> =="
BEFORE="$(snapshot)"
(cd "$FIX_U" && claude -p "Reply with exactly: ok" --settings "$OUT_WIN/injected-settings.json") \
  && echo "claude exit: 0" || echo "claude exit: $?"
AFTER="$(snapshot)"

echo "== results =="
echo "--- injected markers ---"; cat "$OUT_U/markers-injected.log" 2>/dev/null || echo "(none)"
echo "--- user markers ---";     cat "$OUT_U/markers-user.log" 2>/dev/null || echo "(none)"
echo "--- fixture .claude/ diff (empty = untouched) ---"
if diff <(echo "$BEFORE") <(echo "$AFTER"); then echo "(untouched)"; fi

# Strict checks: every expected event per source, both sources in the SAME
# session, project untouched. Weaker checks would false-PASS if e.g. Stop
# delivery regresses in a future CLI version.
has() { grep -q "event=$2" "$1" 2>/dev/null; }
sessions() { sed -n 's/.*session=\([^ ]*\).*/\1/p' "$1" 2>/dev/null | sort -u; }

INJ_OK=0; USR_OK=0; SAME=0; CLEAN=0
has "$OUT_U/markers-injected.log" SessionStart \
  && has "$OUT_U/markers-injected.log" UserPromptSubmit \
  && has "$OUT_U/markers-injected.log" Stop && INJ_OK=1
has "$OUT_U/markers-user.log" SessionStart \
  && has "$OUT_U/markers-user.log" UserPromptSubmit && USR_OK=1
[ -n "$(sessions "$OUT_U/markers-injected.log")" ] \
  && [ "$(sessions "$OUT_U/markers-injected.log")" = "$(sessions "$OUT_U/markers-user.log")" ] && SAME=1
[ "$BEFORE" = "$AFTER" ] && CLEAN=1
echo "== verdict: injected_all_events=$INJ_OK user_all_events=$USR_OK same_session=$SAME project_untouched=$CLEAN =="
if [ $INJ_OK -eq 1 ] && [ $USR_OK -eq 1 ] && [ $SAME -eq 1 ] && [ $CLEAN -eq 1 ]; then
  echo "PASS"
else
  echo "FAIL"; exit 1
fi
