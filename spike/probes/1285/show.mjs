// Helper: print selected parts of a capture file, abbreviated.
//   node show.mjs <capture-stem> [filter]
// filter: "result:<id>" | "method:<name>" | "update:<sessionUpdate>" | "dirs" | "kinds"
import fs from 'node:fs';
import path from 'node:path';
import { CAPTURES, updateKinds } from './lib.mjs';

const [stem, filter = 'kinds', maxArg] = process.argv.slice(2);
const max = Number(maxArg || 1500);
const recs = fs.readFileSync(path.join(CAPTURES, stem + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ins = recs.filter((r) => r.dir === 'in').map((r) => r.frame);
const cut = (o) => {
  const s = JSON.stringify(o);
  return s.length > max ? s.slice(0, max) + ' ...(' + s.length + ' chars)' : s;
};
if (filter === 'kinds') {
  console.log('session/update kinds:', updateKinds(ins));
  const methods = {};
  for (const f of ins) if (f.method) methods[f.method] = (methods[f.method] || 0) + 1;
  console.log('inbound methods:', methods);
  console.log('dirs:', recs.reduce((a, r) => ((a[r.dir] = (a[r.dir] || 0) + 1), a), {}));
} else if (filter.startsWith('result:')) {
  const id = Number(filter.slice(7));
  const f = ins.find((x) => x.id === id && !x.method);
  if (f?.result && typeof f.result === 'object') {
    for (const [k, v] of Object.entries(f.result)) console.log(k + ': ' + cut(v));
  } else console.log(cut(f));
} else if (filter.startsWith('method:')) {
  for (const f of ins.filter((x) => x.method === filter.slice(7))) console.log(cut(f));
} else if (filter.startsWith('update:')) {
  for (const f of ins.filter((x) => x.params?.update?.sessionUpdate === filter.slice(7))) console.log(cut(f.params.update));
} else if (filter === 'notes') {
  for (const r of recs.filter((r) => r.dir !== 'in')) console.log(cut(r));
}
