// Strip ANSI/OSC control sequences from a captured PTY log: node strip-ansi.js <file>
const fs = require('fs');
let s = fs.readFileSync(process.argv[2], 'utf8');
s = s
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[=>NOM78]/g, '')
  .replace(/[\x00-\x08\x0b-\x1f]/g, '\n')
  .replace(/\n{3,}/g, '\n\n');
console.log(s);
