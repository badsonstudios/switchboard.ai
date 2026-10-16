// Spawn-shape check (#1285 Q1): run `npx -y <adapter> --version` through each
// candidate Windows spawn shape and record what comes back. No model, no login.
//   node probe-a-spawn-shapes.mjs   -> writes captures/a-spawn-shapes.jsonl
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { execSpec, launchSpec, npxCmd, ADAPTER, SANDBOX, CAPTURES } from './lib.mjs';

const shapes = [
  ['execSpec, absolute npx.cmd (path has a space)', execSpec(npxCmd(), ['-y', ADAPTER, '--version'])],
  ['execSpec, bare npx.cmd (PATH lookup by cmd.exe)', execSpec('npx.cmd', ['-y', ADAPTER, '--version'])],
  ['launchSpec, absolute npx.cmd', launchSpec(npxCmd(), ['-y', ADAPTER, '--version'])],
];
const out = path.join(CAPTURES, 'a-spawn-shapes.jsonl');
fs.mkdirSync(CAPTURES, { recursive: true });
fs.writeFileSync(out, '');
for (const [label, spec] of shapes) {
  const r = await new Promise((res) => {
    const c = spawn(spec.file, spec.argv, { cwd: SANDBOX, windowsVerbatimArguments: spec.windowsVerbatimArguments, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let so = '';
    let se = '';
    c.stdout.on('data', (d) => (so += d));
    c.stderr.on('data', (d) => (se += d));
    c.on('exit', (code) => res({ code, stdout: so, stderr: se }));
    c.stdin.end();
  });
  const rec = { label, file: spec.file, argv: spec.argv, windowsVerbatimArguments: spec.windowsVerbatimArguments, ...r };
  fs.appendFileSync(out, JSON.stringify(rec) + '\n');
  console.log(JSON.stringify(rec));
}
