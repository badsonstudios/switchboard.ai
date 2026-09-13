// Bundle-and-run wrapper for #779's corpus probe.
//
// The probe imports `src/main/transcripts/drift.ts` on purpose — measuring the
// corpus with a hand-copied second walker would measure the copy, and the whole
// question is what THE detector we ship does not know about. esbuild is already a
// dependency (electron-vite), so bundling is cheaper than adding a TS runner.
//
// Usage: node spike/probes/779/run.mjs [transcriptsRoot]
import { build } from 'esbuild';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-probe-779-')), 'probe.cjs');

await build({
  entryPoints: [path.join(here, 'corpus-drift.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'warning',
});

const r = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
