// S-06: status listener — maps hook events to session status transitions,
// driven ONLY by hooks (no transcript polling). Same §5.29 floor as s03.
//   node status-listener.js <outDir>
// Responds 200 {} immediately (fire-and-forget from the hook's perspective).
//
// Mapping probed:
//   SessionStart              -> starting
//   UserPromptSubmit          -> working
//   PreToolUse                -> working:<tool>      (enrichment, optional)
//   Notification              -> needs-permission | needs-input | notified:<other>
//   SubagentStop              -> (transient) subagent-done, status unchanged
//   Stop                      -> done
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2];
if (!OUT) { console.error('usage: node status-listener.js <outDir>'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const token = crypto.randomBytes(16).toString('hex');
let status = 'unknown';
const transitions = [];
const log = (line) =>
  fs.appendFileSync(path.join(OUT, 'status.log'), `${new Date().toISOString()} ${line}\n`);

function setStatus(next, cause) {
  if (next === status) return;
  const t = { at: new Date().toISOString(), from: status, to: next, cause };
  transitions.push(t);
  status = next;
  log(`STATUS ${t.from} -> ${t.to} (${cause})`);
  fs.writeFileSync(path.join(OUT, 'transitions.json'), JSON.stringify(transitions, null, 2));
}

const server = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') { res.writeHead(403); return res.end(); }
  // header name matches s03/hook-forward.js, which this probe reuses verbatim
  if (req.headers['x-s03-token'] !== token) { res.writeHead(401); return res.end(); }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}'); // ack immediately — status hooks must never hold the CLI
    let e = {};
    try { e = JSON.parse(body); } catch (_) {}
    const evt = e.hook_event_name || '?';
    log(`EVENT ${evt} ${JSON.stringify({ message: e.message, title: e.title, tool: e.tool_name, notification_type: e.notification_type }).slice(0, 220)}`);
    switch (evt) {
      case 'SessionStart': setStatus('starting', evt); break;
      case 'UserPromptSubmit': setStatus('working', evt); break;
      case 'PreToolUse': setStatus(`working:${e.tool_name || 'tool'}`, evt); break;
      case 'Notification': {
        const msg = `${e.message || ''} ${e.title || ''}`;
        if (/permission/i.test(msg)) setStatus('needs-permission', `${evt}: ${e.message}`);
        else if (/waiting|input|idle/i.test(msg)) setStatus('needs-input', `${evt}: ${e.message}`);
        else setStatus(`notified`, `${evt}: ${e.message}`);
        break;
      }
      case 'SubagentStop': log('TRANSIENT subagent-done (status unchanged)'); break;
      case 'Stop': setStatus('done', evt); break;
      default: log(`UNMAPPED event ${evt}`);
    }
  });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  fs.writeFileSync(path.join(OUT, 'listener.json'), JSON.stringify({ port, token, pid: process.pid }));
  log(`LISTENING port=${port}`);
  console.log(`listening on 127.0.0.1:${port}`);
});
