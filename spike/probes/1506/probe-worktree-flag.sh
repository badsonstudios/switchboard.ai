#!/usr/bin/env bash
# #1506 probe: what does the PATH `claude` CLI's -w/--worktree flag do?
# Measures: where the worktree lands, which branch/commit it starts from,
# what the stream-json init reports as cwd, what is left at session end,
# how --resume behaves, and what a second session with the same name does.
# Cheapest model, one turn each, throwaway repo under the system temp dir.
# Usage: bash spike/probes/1506/probe-worktree-flag.sh > out.txt 2>&1
set -u
ROOT="$(mktemp -d)"
REPO="$ROOT/repo"
ORIGIN="$ROOT/origin.git"
echo "== root: $ROOT"

git init -q --bare -b main "$ORIGIN"
git init -q -b main "$REPO"
cd "$REPO" || exit 1
git config user.email probe@example.invalid
git config user.name probe
echo one > a.txt
git add a.txt && git commit -qm "main: one"
git remote add origin "$ORIGIN"
git push -q origin main
MAIN_SHA=$(git rev-parse HEAD)
# Local HEAD moves to a feature branch with an extra commit, and the remote
# main gets ahead too, so the base tells us HEAD vs local main vs origin/main.
git checkout -qb feature
echo two > b.txt && git add b.txt && git commit -qm "feature: two"
FEATURE_SHA=$(git rev-parse HEAD)
git clone -q "$ORIGIN" "$ROOT/other" && (cd "$ROOT/other" && git config user.email p@e.invalid && git config user.name p && echo three > c.txt && git add c.txt && git commit -qm "origin: three" && git push -q origin main)
git fetch -q origin
ORIGIN_SHA=$(git rev-parse origin/main)
echo "main=$MAIN_SHA feature(HEAD)=$FEATURE_SHA origin/main=$ORIGIN_SHA"
# a git-ignored file, to see whether it is copied into the worktree
echo ".env" > .gitignore && git add .gitignore && git commit -qm ignore && echo SECRET=1 > .env
FEATURE_SHA=$(git rev-parse HEAD)

run() { # $1 label, rest = args
  local label="$1"; shift
  echo; echo "== $label: claude $*"
  claude -p "Reply with the single word ok." --model haiku --max-turns 1 \
    --output-format stream-json --verbose "$@" > "$ROOT/$label.jsonl" 2> "$ROOT/$label.err"
  echo "exit=$?"
  node -e '
    const fs=require("fs"); const lines=fs.readFileSync(process.argv[1],"utf8").split(/\r?\n/).filter(Boolean);
    for (const l of lines) { try { const m=JSON.parse(l);
      if (m.type==="system"&&m.subtype==="init") console.log("init cwd:", m.cwd, "session:", m.session_id);
      else if (m.type==="system") console.log("system", m.subtype, JSON.stringify(m).slice(0,300));
      else if (m.type==="result") console.log("result:", m.subtype, m.is_error, String(m.result).slice(0,80));
    } catch {} }' "$ROOT/$label.jsonl"
  head -c 400 "$ROOT/$label.err"
}

run first --worktree probe1
echo "-- after first session ended:"
git worktree list --porcelain
git branch -a -vv
SID=$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split(/\r?\n/).filter(Boolean).map(x=>{try{return JSON.parse(x)}catch{return {}}}).find(m=>m.subtype==="init");console.log(l?l.session_id:"")' "$ROOT/first.jsonl")
WT=$(git worktree list --porcelain | awk '/^worktree /{p=$2} /probe1/{print p; exit}')
echo "worktree path: $WT"
[ -n "$WT" ] && { echo "-- worktree HEAD: $(git -C "$WT" rev-parse HEAD)"; ls -la "$WT"; }

run resume-from-root --resume "$SID"
run same-name-again --worktree probe1
echo "-- after same-name-again:"; git worktree list
run unnamed --worktree
echo "-- after unnamed:"; git worktree list; git branch

echo; echo "== status of the probe repo at the end"
git status --short
echo "ROOT=$ROOT (delete by hand when read)"
