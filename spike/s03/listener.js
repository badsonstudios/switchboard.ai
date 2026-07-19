// S-03: HookListener stand-in. Loopback-only HTTP server implementing the
// §5.29 floor: Host-header allowlist AND per-session token, both always.
// Scenario-driven auto-decider simulates the human: respond <decision> after
// <delayMs>, or never ('hang').
//
//   node listener.js <outDir> <decision: allow|deny|ask|hang> [delayMs]
//
// Writes <outDir>/listener.json {port, token, pid} for the settings generator,
// and appends a timestamped audit trail to <outDir>/listener.log.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2];
const DECISION = process.argv[3] || 'allow';
const DELAY = Number(process.argv[4] || 0);
if (!OUT) { console.error('usage: node listener.js <outDir> <decision> [delayMs]'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const token = crypto.randomBytes(16).toString('hex');
const log = (line) =>
  fs.appendFileSync(path.join(OUT, 'listener.log'), `${new Date().toISOString()} ${line}\n`);

const server = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') {
    log(`REJECT bad-host host=${req.headers.host}`);
    res.writeHead(403); return res.end();
  }
  if (req.headers['x-s03-token'] !== token) {
    log('REJECT bad-token');
    res.writeHead(401); return res.end();
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let evt = {};
    try { evt = JSON.parse(body); } catch (_) {}
    log(`REQUEST event=${evt.hook_event_name} tool=${evt.tool_name} session=${evt.session_id} ` +
        `input=${JSON.stringify(evt.tool_input || {}).slice(0, 160)}`);
    if (DECISION === 'hang') { log('HANG — never responding (timeout probe)'); return; }
    setTimeout(() => {
      const reason =
        DECISION === 'deny'
          ? 'S03-DENY-REASON: switchboard operator rejected this edit'
          : `S03 auto-${DECISION}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ decision: DECISION, reason }));
      log(`RESPONDED ${DECISION} after ${DELAY}ms hold`);
    }, DELAY);
  });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  fs.writeFileSync(
    path.join(OUT, 'listener.json'),
    JSON.stringify({ port, token, pid: process.pid, decision: DECISION, delayMs: DELAY })
  );
  log(`LISTENING port=${port} decision=${DECISION} delay=${DELAY}ms`);
  console.log(`listening on 127.0.0.1:${port}`);
});
