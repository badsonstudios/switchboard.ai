#!/usr/bin/env bash
# S-03 headless scenario runner. Each scenario: fresh fixture file state,
# start listener with a decision policy, generate --settings with the
# hook-forward command (port+token baked in), run `claude -p` asking for a
# file write, record: file mutated? CLI output? listener/hook timing?
#
# Scenarios (default: all):
#   baseline      no hooks at all — what does headless default-deny look like?
#   allow         listener allows after 2s hold
#   deny          listener denies with a reason; prompt asks the model to echo
#                 the refusal it saw (proves the reason reaches the model)
#   ask           listener answers "ask" — headless has no TUI; what happens?
#   hang          listener never answers, hook has NO timeout field — measures
#                 the DEFAULT hook timeout budget + post-timeout behavior
#   longhold      listener allows after 90s, hook timeout field = 600 — proves
#                 human-scale holds survive when the budget is raised
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
S03_WIN="$(cygpath -m "$REPO/spike/s03")"
OUT_WIN="$(cygpath -m "$REPO/.claude/work_files/s03")"
OUT_U="$(cygpath -u "$OUT_WIN")"
FIX_WIN="C:/tmp/s03-project"
FIX_U="$(cygpath -u "$FIX_WIN")"

[ $# -gt 0 ] && SCENARIOS=("$@") || SCENARIOS=(baseline allow deny ask hang longhold dead)

mkdir -p "$OUT_U" "$FIX_U"
echo "fixture" > "$FIX_U/README.md"

listener_pid=""
cleanup() { [ -n "$listener_pid" ] && kill "$listener_pid" 2>/dev/null || true; }
trap cleanup EXIT

gen_settings() { # $1=scenario dir (unix), $2=hook timeout field ("" = none)
  local dm port token tfield=""
  dm="$(cygpath -m "$1")"
  port="$(node -p "JSON.parse(require('fs').readFileSync('$dm/listener.json','utf8')).port")"
  token="$(node -p "JSON.parse(require('fs').readFileSync('$dm/listener.json','utf8')).token")"
  [ -n "$2" ] && tfield="\"timeout\": $2,"
  cat > "$1/settings.json" <<EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", $tfield "command": "node $S03_WIN/hook-forward.js $port $token $(cygpath -m "$1")/hook.log" } ]
      }
    ]
  }
}
EOF
}

run_claude() { # $1=scenario dir (unix), $2=prompt, $3=settings? yes/no
  local args=(-p "$2")
  [ "$3" = "yes" ] && args+=(--settings "$(cygpath -m "$1")/settings.json")
  local t0 t1
  t0=$(date +%s)
  (cd "$FIX_U" && timeout 900 claude "${args[@]}" >"$1/claude-out.txt" 2>"$1/claude-err.txt") \
    && echo "exit=0" >"$1/claude-exit.txt" || echo "exit=$?" >"$1/claude-exit.txt"
  t1=$(date +%s)
  echo "wall=$((t1 - t0))s" >>"$1/claude-exit.txt"
}

for sc in "${SCENARIOS[@]}"; do
  D="$OUT_U/$sc"
  rm -rf "$D"; mkdir -p "$D"
  rm -f "$FIX_U/probe-$sc.txt"
  echo ""
  echo "=== scenario: $sc ==="
  PROMPT="Use the Write tool to create the file probe-$sc.txt containing exactly the single line: hook-probe-$sc. Do not use Bash. If the tool call is blocked or refused, reply with the exact block/refusal message you received; otherwise reply: WROTE-OK"

  case "$sc" in
    baseline)
      run_claude "$D" "$PROMPT" no
      ;;
    allow)
      node "$S03_WIN/listener.js" "$(cygpath -m "$D")" allow 2000 & listener_pid=$!
      sleep 1; gen_settings "$D" ""
      run_claude "$D" "$PROMPT" yes
      kill $listener_pid 2>/dev/null || true; listener_pid=""
      ;;
    deny)
      node "$S03_WIN/listener.js" "$(cygpath -m "$D")" deny 1000 & listener_pid=$!
      sleep 1; gen_settings "$D" ""
      run_claude "$D" "$PROMPT" yes
      kill $listener_pid 2>/dev/null || true; listener_pid=""
      ;;
    ask)
      node "$S03_WIN/listener.js" "$(cygpath -m "$D")" ask 1000 & listener_pid=$!
      sleep 1; gen_settings "$D" ""
      run_claude "$D" "$PROMPT" yes
      kill $listener_pid 2>/dev/null || true; listener_pid=""
      ;;
    hang)
      node "$S03_WIN/listener.js" "$(cygpath -m "$D")" hang & listener_pid=$!
      sleep 1; gen_settings "$D" ""
      run_claude "$D" "$PROMPT" yes
      kill $listener_pid 2>/dev/null || true; listener_pid=""
      ;;
    longhold)
      node "$S03_WIN/listener.js" "$(cygpath -m "$D")" allow 90000 & listener_pid=$!
      sleep 1; gen_settings "$D" 600
      run_claude "$D" "$PROMPT" yes
      kill $listener_pid 2>/dev/null || true; listener_pid=""
      ;;
    dead)
      # Fail-open probe: settings point at a listener that is already gone.
      node "$S03_WIN/listener.js" "$(cygpath -m "$D")" allow 0 & listener_pid=$!
      sleep 1; gen_settings "$D" ""
      kill $listener_pid 2>/dev/null || true; listener_pid=""
      sleep 0.5
      run_claude "$D" "$PROMPT" yes
      ;;
    *) echo "unknown scenario $sc"; exit 1 ;;
  esac

  echo "--- file created? ---"
  if [ -f "$FIX_U/probe-$sc.txt" ]; then echo "YES: $(cat "$FIX_U/probe-$sc.txt")"; else echo "NO"; fi
  echo "--- claude output ---"; cat "$D/claude-out.txt" 2>/dev/null || true
  echo "--- claude exit ---"; cat "$D/claude-exit.txt"
  echo "--- hook log ---"; cat "$D/hook.log" 2>/dev/null || echo "(none)"
  echo "--- listener log ---"; cat "$D/listener.log" 2>/dev/null || echo "(none)"
done

echo ""
echo "=== security floor negative test (no token / bad host) ==="
D="$OUT_U/sec"
rm -rf "$D"; mkdir -p "$D"
node "$S03_WIN/listener.js" "$(cygpath -m "$D")" allow 0 & listener_pid=$!
sleep 1
port="$(node -p "JSON.parse(require('fs').readFileSync('$(cygpath -m "$D")/listener.json','utf8')).port")"
token="$(node -p "JSON.parse(require('fs').readFileSync('$(cygpath -m "$D")/listener.json','utf8')).token")"
echo "no-token:            HTTP $(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$port/pretooluse" -d '{}')"
echo "bad-host(good token): HTTP $(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Host: evil.example' -H "x-s03-token: $token" "http://127.0.0.1:$port/pretooluse" -d '{}')"
kill $listener_pid 2>/dev/null || true; listener_pid=""
cat "$D/listener.log"
echo "done"
