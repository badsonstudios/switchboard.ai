// Read the running probe's summary without disturbing it.
const fs = require('fs');
const path = require('path');

const OUT = process.env.S11_OUT || path.join(__dirname, '..', 'findings', 'artifacts', 's11');
const summaryPath = path.join(OUT, 'longrun-summary.json');
if (!fs.existsSync(summaryPath)) {
  console.error(`[s11] no summary at ${summaryPath} — not started?`);
  process.exit(1);
}
const S = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

const pidFile = path.join(OUT, 'longrun.pid');
let running = false;
if (fs.existsSync(pidFile)) {
  try { process.kill(Number(fs.readFileSync(pidFile, 'utf8').trim()), 0); running = true; } catch {}
}

const mins = (ms) => (ms / 60000).toFixed(1) + 'm';
console.log(`probe    : ${S.probe}`);
console.log(`started  : ${S.startedAt}   host process ${running ? 'RUNNING' : 'NOT running'}`);
console.log(`elapsed  : ${mins(S.elapsedMs || 0)} of ${mins(S.config.DURATION_MS)}`);
console.log(`child    : ${S.alive ? 'alive' : 'DEAD ' + JSON.stringify(S.exit)}`);
console.log(`cli      : ${S.init ? S.init.version + '  model=' + S.init.model + '  auth=' + S.init.apiKeySource : '(no init yet)'}`);
console.log(`stdout   : ${(S.stdoutBytes / 1048576).toFixed(2)} MB / ${S.stdoutLines} lines / ${S.parseFailures} parse failures`);
console.log(`keepalive: ${S.keepAlives.count}`);
console.log(`turns    : ${S.turns.length} sent, ${S.turns.filter((t) => t.latencyMs !== null).length} completed`);
for (const t of S.turns) {
  console.log(`   #${t.n} ${t.kind.padEnd(13)} @${mins(t.sentMs).padStart(7)}  ${t.latencyMs === null ? 'PENDING' : t.latencyMs + 'ms'}` +
    (t.usage ? `  in=${t.usage.input} out=${t.usage.output} cacheRead=${t.usage.cacheRead}` : ''));
}
console.log(`backpres.: ${S.backpressure ? S.backpressure.verdict : '(not reached)'}`);
const last = S.samples[S.samples.length - 1];
if (last) console.log(`memory   : child ${last.childRssMb}MB (${last.procCount} procs), host ${last.hostRssMb}MB`);
if (S.verdicts && Object.keys(S.verdicts).length) {
  console.log('\nVERDICTS');
  for (const [k, v] of Object.entries(S.verdicts)) console.log(`  ${k.padEnd(30)} ${v}`);
}
