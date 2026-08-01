// Stop the probe cleanly — SIGTERM makes it compute verdicts and write the
// summary before exiting. Killing it any other way loses the verdicts block.
const fs = require('fs');
const path = require('path');

const OUT = process.env.S11_OUT || path.join(__dirname, '..', 'findings', 'artifacts', 's11');
const pidFile = path.join(OUT, 'longrun.pid');
if (!fs.existsSync(pidFile)) { console.error('[s11] no pid file'); process.exit(1); }
const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
try {
  process.kill(pid, 'SIGTERM');
  console.log(`[s11] SIGTERM → ${pid}; summary is written on the way out`);
} catch (e) {
  console.error(`[s11] pid ${pid} not running (${e.code})`);
}
