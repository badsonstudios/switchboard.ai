// S-04 tolerant-reader test: append a mix of valid-shaped and garbage lines to
// a synthetic transcript inside a fake projects root, run the tailer's parse
// loop against it, and verify it survives and counts correctly.
// Run: node malformed-test.js <outDir>
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const outDir = process.argv[2];
fs.mkdirSync(outDir, { recursive: true });

// Point the tailer at the REAL projects root but a synthetic new file: we
// write into a scratch project dir the CLI never uses.
const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
const fakeDir = path.join(projectsRoot, 's04-malformed-test');
fs.mkdirSync(fakeDir, { recursive: true });
const file = path.join(fakeDir, `synthetic-${process.pid}.jsonl`);

const lines = [
  JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'x.txt' } }] } }),
  'this is not json at all {{{',
  JSON.stringify({ type: 'totally-unknown-future-type', payload: { nested: [1, 2, 3] } }),
  '{"truncated": tru',
  JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result' }] } }),
  '', // blank
  JSON.stringify({ type: 'assistant', message: { usage: { output_tokens: 7 }, content: 'string-content-not-array' } }),
];

// Start the tailer, then append lines with delays (exercises partial reads).
const { spawn } = require('child_process');
const tailer = spawn(process.execPath, [
  path.join(__dirname, 'tail-transcript.js'), 'C:/synthetic', outDir, '--follow-ms', '8000',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
tailer.stdout.on('data', (d) => (out += d));
tailer.stderr.on('data', (d) => (out += d));

setTimeout(() => {
  let i = 0;
  const iv = setInterval(() => {
    if (i >= lines.length) return clearInterval(iv);
    fs.appendFileSync(file, lines[i] + '\n');
    i++;
  }, 300);
}, 1500);

tailer.on('exit', (code) => {
  fs.writeFileSync(path.join(outDir, 'malformed-stdout.txt'), out);
  let summary = {};
  try { summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8')); } catch (_) {}
  const ok =
    code === 0 &&
    summary.lines === 6 &&      // blank line skipped
    summary.malformed === 2 &&  // the two garbage lines
    summary.parsed === 4 &&
    (summary.types || {})['totally-unknown-future-type'] === 1 &&
    summary.tokens && summary.tokens.output === 12;
  console.log(`lines=${summary.lines} malformed=${summary.malformed} parsed=${summary.parsed} exit=${code}`);
  console.log(ok ? 'MALFORMED-TEST PASS' : 'MALFORMED-TEST FAIL');
  try { fs.rmSync(fakeDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(ok ? 0 : 1);
});
