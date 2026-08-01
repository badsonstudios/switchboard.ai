// Launch probe 1 DETACHED so it survives the session that started it — an
// 8-hour probe must not die when a terminal or an agent session closes.
// Writes a pid file; `node status.cjs` reads the summary, `node stop.cjs` ends
// it cleanly (the probe writes its verdicts on SIGTERM).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = process.env.S11_OUT || path.join(__dirname, '..', 'findings', 'artifacts', 's11');
fs.mkdirSync(OUT, { recursive: true });

const pidFile = path.join(OUT, 'longrun.pid');
if (fs.existsSync(pidFile)) {
  const old = Number(fs.readFileSync(pidFile, 'utf8').trim());
  let running = false;
  try { process.kill(old, 0); running = true; } catch {}
  if (running) {
    console.error(`[s11] already running as pid ${old} — stop.cjs first, or delete ${pidFile}`);
    process.exit(1);
  }
}

const logFile = path.join(OUT, 'longrun-stdout.log');
const log = fs.openSync(logFile, 'a');
const child = spawn(process.execPath, [path.join(__dirname, 'probe-1-longrun.cjs')], {
  detached: true,
  stdio: ['ignore', log, log],
  windowsHide: true,
  env: { ...process.env, S11_OUT: OUT },
});
child.unref();
fs.writeFileSync(pidFile, String(child.pid));

console.log(`[s11] probe 1 running detached as pid ${child.pid}`);
console.log(`[s11] summary : ${path.join(OUT, 'longrun-summary.json')}`);
console.log(`[s11] events  : ${path.join(OUT, 'longrun-events.ndjson')}`);
console.log(`[s11] stdout  : ${logFile}`);
