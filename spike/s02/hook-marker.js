// S-02 probe: hook side-effect marker. Invoked as a Claude Code hook command:
//   node <this file> <tag> <logfile>
// Appends one line per firing: timestamp, tag (injected|user), the hook event
// name parsed from the JSON Claude pipes on stdin, and a shell fingerprint
// (which env vars are present tells us what shell ran the command on Windows).
const fs = require('fs');
const path = require('path');

const [, , tag, logfile] = process.argv;

let stdin = '';
try {
  stdin = fs.readFileSync(0, 'utf8');
} catch (_) {}

let event = '?';
let session = '?';
let cwd = '?';
try {
  const j = JSON.parse(stdin);
  event = j.hook_event_name || '?';
  session = j.session_id || '?';
  cwd = j.cwd || '?';
} catch (_) {}

const shellHints = ['SHLVL', 'BASH', 'ComSpec', 'PSModulePath', 'MSYSTEM']
  .filter((k) => process.env[k] !== undefined)
  .join(',');

fs.mkdirSync(path.dirname(logfile), { recursive: true });
fs.appendFileSync(
  logfile,
  `${new Date().toISOString()} tag=${tag} event=${event} session=${session} cwd=${cwd} shellHints=[${shellHints}]\n`
);
