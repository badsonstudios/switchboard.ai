// #1612 probe: an exec-form hook. Records which event fired, whether a shell
// was in the way (parent process name is not observable cheaply, so we record
// argv exactly as received: a shell would have mangled the quoted arg), and
// the time, then echoes nothing (a status hook answers nothing).
const fs = require('fs');
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
let ev = '?';
try { ev = JSON.parse(stdin).hook_event_name; } catch {}
const born = Date.now() - process.uptime() * 1000;
fs.appendFileSync(process.argv[2], JSON.stringify({ ev, argv: process.argv.slice(3), born: Math.round(born), at: Date.now() }) + '\n');
