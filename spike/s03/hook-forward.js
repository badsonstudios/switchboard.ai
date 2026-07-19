// S-03: the PreToolUse hook command. Forwards the hook JSON from stdin to the
// listener, blocks until the "human" decision arrives, then emits Claude
// Code's hook-output JSON. Listener unreachable => fail-open (exit 0, no
// output => CLI default behavior), logged.
//
//   node hook-forward.js <port> <token> <logfile>
const fs = require('fs');
const http = require('http');

const [, , port, token, logfile] = process.argv;
const mark = (s) => {
  try { fs.appendFileSync(logfile, `${new Date().toISOString()} ${s}\n`); } catch (_) {}
};

const stdin = fs.readFileSync(0, 'utf8');
const t0 = Date.now();
mark(`hook invoked pid=${process.pid}`);

const req = http.request(
  {
    host: '127.0.0.1',
    port,
    path: '/pretooluse',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-s03-token': token },
  },
  (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      let d = {};
      try { d = JSON.parse(body); } catch (_) {}
      const decision = ['allow', 'deny', 'ask'].includes(d.decision) ? d.decision : null;
      mark(`decision=${d.decision || 'invalid'} roundtrip=${Date.now() - t0}ms`);
      if (decision) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: decision,
              permissionDecisionReason: d.reason || '',
            },
          })
        );
      }
      process.exit(0);
    });
  }
);
req.on('error', (e) => {
  mark(`listener unreachable (${e.message}) — fail-open, no output`);
  process.exit(0);
});
req.end(stdin);
// If the listener hangs, this process hangs with it — the CLI's own hook
// timeout is then the thing being measured.
