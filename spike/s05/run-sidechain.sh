#!/usr/bin/env bash
# S-05 probe: watch transcript dir while a session (a) writes a TodoWrite plan
# and (b) spawns a Task subagent that uses tools. What do sidechains look like?
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_WIN="$(cygpath -m "$REPO/.claude/work_files/s05")"
OUT_U="$(cygpath -u "$OUT_WIN")"
FIX_WIN="C:/tmp/s05-project"
FIX_U="$(cygpath -u "$FIX_WIN")"

rm -rf "$OUT_U"; mkdir -p "$OUT_U" "$FIX_U"
echo "fixture" > "$FIX_U/README.md"
printf 'alpha\nbravo\ncharlie\n' > "$FIX_U/data.txt"

node "$(cygpath -m "$REPO/spike/s05")/tail-all.js" "$FIX_WIN" "$OUT_WIN" 240000 \
  > "$OUT_U/watcher-stdout.txt" 2>&1 &
WPID=$!
trap 'kill $WPID 2>/dev/null || true' EXIT
sleep 2

(cd "$FIX_U" && timeout 220 claude -p "First, use TodoWrite to create a todo list with exactly these 3 items: 'inspect data', 'summarize data', 'report'. Then use the Task tool (general-purpose agent) to: read data.txt in this project and report how many lines it has. Mark todos complete as you go. Finally reply with just: SIDECHAIN-DONE" \
  --allowedTools "TodoWrite Task Read Bash Grep Glob" ) || echo "claude exit: $?"

wait $WPID || true
echo "--- watcher log ---"
cat "$OUT_U/watcher.log" 2>/dev/null | head -30
echo "--- summary of observations ---"
node -e "
const o=require('$OUT_WIN/observations.json');
for(const [f,pf] of Object.entries(o.files)){
  console.log('FILE', pf.rel, 'inProjectSlug='+pf.inProjectSlug, 'subagent='+pf.isSubagentFile, 'firstSeen='+pf.firstSeenMs+'ms', 'lines='+pf.lines, 'sidechain='+pf.sidechainLines);
  console.log('  meta:', JSON.stringify(pf.meta));
  console.log('  types:', JSON.stringify(pf.types));
  console.log('  agents:', JSON.stringify(pf.agents));
  console.log('  tools:', JSON.stringify(pf.tools.map(t=>t.name+(t.sidechain?'[sc]':'')+(t.task?('->'+t.task.type):'')).join(',')));
}
const tw=o.record.filter(r=>r.kind==='todowrite');
console.log('todowrite events:', tw.length, JSON.stringify(tw.map(t=>t.todos&&t.todos.map(x=>x.status))));
const sc=o.record.filter(r=>r.kind==='line'&&r.isSidechain);
console.log('sidechain lines:', sc.length, 'sample:', JSON.stringify(sc[0]||null));
const lags=o.record.filter(r=>r.lagMs!=null).map(r=>r.lagMs).sort((a,b)=>a-b);
console.log('lag med/max:', lags[Math.floor(lags.length/2)], lags[lags.length-1]);
"
