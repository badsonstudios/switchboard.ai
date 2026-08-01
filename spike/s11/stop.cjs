// Ask the probe to stop and write its final summary.
//
// This drops a SENTINEL FILE rather than signalling. `process.kill(pid,
// 'SIGTERM')` looks like the obvious answer and is wrong on Windows: it maps to
// TerminateProcess, the handler never runs, and the first real stop of this
// probe produced a summary with no verdicts in it. The sentinel behaves the
// same on every platform.
//
// It is also no longer load-bearing — `writeSummary()` computes verdicts on
// every periodic write, so the file on disk is complete even if the process is
// killed rudely. This just makes the exit tidy.
const fs = require('fs');
const path = require('path');

const OUT = process.env.S11_OUT || path.join(__dirname, '..', 'findings', 'artifacts', 's11');
const stopFile = path.join(OUT, 'stop.request');
const pidFile = path.join(OUT, 'longrun.pid');

if (!fs.existsSync(OUT)) {
  console.error(`[s11] no run directory at ${OUT}`);
  process.exit(1);
}

let pid = null;
if (fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
let running = false;
if (pid) {
  try {
    process.kill(pid, 0);
    running = true;
  } catch {
    /* already gone */
  }
}

// The sentinel goes down UNCONDITIONALLY. The pid file only tells us what
// `start-longrun.cjs` recorded, and a probe started any other way — directly,
// or from a shell — has no pid file at all while being very much alive. Making
// the stop conditional on that bookkeeping meant "I can't see it, so I won't
// try", which is the wrong way round for a stop command.
fs.writeFileSync(stopFile, String(Date.now()));

if (running) {
  console.log(`[s11] stop requested (pid ${pid}). It exits within ~5s and writes its final summary.`);
} else {
  console.log(
    `[s11] stop requested. No live pid on file${pid ? ` (pid ${pid} is gone)` : ''}, so this may be a no-op —`
  );
  console.log(`[s11] but any probe running on this directory will see the sentinel and exit cleanly.`);
}
console.log(`[s11] summary (complete at all times, verdicts included): ${path.join(OUT, 'longrun-summary.json')}`);
console.log(`[s11] read it with: node status.cjs`);
