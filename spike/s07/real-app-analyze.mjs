// Summarize a driver report into the numbers the findings section needs.
import fs from 'fs';
const file = process.argv[2];
const r = JSON.parse(fs.readFileSync(file, 'utf8'));
const row = (name, p) =>
  p
    ? [
        name.padEnd(14),
        `n=${String(p.n).padEnd(3)}`,
        `cpu ${String(p.cpuPctAvg).padStart(6)}% avg / ${String(p.cpuPctMax).padStart(6)}% max`,
        `app ${String(p.appCpuPctAvg).padStart(5)}%`,
        `cli ${String(p.cliCpuPctAvg).padStart(6)}%`,
        `ws ${String(p.workingSetMBAvg).padStart(7)}MB`,
        `(main ${p.mainMBAvg} rend ${p.rendererMBAvg} gpu ${p.gpuMBAvg} util ${p.utilityMBAvg} cli ${p.cliMBAvg})`,
        `perSess ${p.perSessionMB}MB`,
        `stall ${p.renderer?.maxStallMs}ms (>50: ${p.renderer?.over50}, >100: ${p.renderer?.over100})`,
        `fps ${p.renderer?.fps}`,
        p.ui ? `jump ${p.ui.jumpMs?.avg}/${p.ui.jumpMs?.max}ms input ${p.ui.inputMs?.avg}/${p.ui.inputMs?.max}ms` : '',
        `samples ${p.samples}`,
      ].join('  ')
    : `${name}: (none)`;

console.log(`# ${file}`);
console.log(`build ${JSON.stringify(r.build)} transport=${r.transport} turns=${r.realTurns}`);
console.log(`machine ${r.machine?.cpus} cores, ${r.machine?.totalMemMB}MB, ${r.machine?.cpu}`);
console.log(`window ${JSON.stringify(r.occlusion)}`);
console.log(`transcripts .jsonl written: ${r.transcriptFiles}`);
for (const [k, p] of Object.entries(r.phases)) console.log(row(k, p));
console.log('\n-- process mix at each phase --');
for (const [k, snap] of Object.entries(r.procSnapshots ?? {})) {
  const byType = {};
  for (const p of snap) {
    byType[p.type] = byType[p.type] ?? { n: 0, mb: 0 };
    byType[p.type].n++;
    byType[p.type].mb += p.wsMB;
  }
  console.log(k.padEnd(14), JSON.stringify(byType));
}
console.log('\n-- session add latency --');
const adds = (r.events ?? []).filter((e) => e.kind === 'add').map((e) => e.ms);
if (adds.length) console.log(`adds n=${adds.length} avg ${Math.round(adds.reduce((a, b) => a + b) / adds.length)}ms max ${Math.max(...adds)}ms`);
for (const e of (r.events ?? []).filter((e) => e.kind.startsWith('cards')))
  console.log(e.kind, JSON.stringify((e.cards ?? []).map((c) => c.status)));
console.log('\n-- turns --');
console.log(JSON.stringify(r.turns?.map((t) => t.kind).reduce((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {})));
