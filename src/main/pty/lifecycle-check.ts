// P1-E2-01 done-when check: spawn→resize→write→kill across 12 concurrent
// PTYs, clean. Compiled as a second main-process entry (out/main/pty-check.js)
// and run under `electron --run-as-node` so node-pty's Electron-ABI build
// loads without a window. Exits 0 on PASS, 1 on FAIL.
import { PtyService } from './pty-service';

const N = Number(process.env.PTY_CHECK_N || 12);
const service = new PtyService();
const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh';
const marker = (i: number) => `pty-check-${i}-ok`;

async function main(): Promise<number> {
  const outputs = new Map<number, string>();
  const exits = new Map<number, number>();

  // interactive shells that echo a marker, then wait for input
  for (let i = 0; i < N; i++) {
    const s = service.spawn({
      id: `check-${i}`,
      command: shell,
      args: [],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      scrollbackBytes: 64 * 1024,
    });
    outputs.set(i, '');
    s.onData((d) => outputs.set(i, outputs.get(i)! + d));
    s.onExit((code) => exits.set(i, code));
  }
  console.log(`[pty-check] spawned ${N} ptys: ${service.list().map((s) => s.pid).join(',')}`);

  await sleep(1500);
  for (let i = 0; i < N; i++) {
    const s = service.get(`check-${i}`)!;
    s.resize(100, 40); // mid-life resize
    s.write(`echo ${marker(i)}\r`);
  }

  // wait for all markers to appear in output
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const missing = [...outputs.entries()].filter(([i, o]) => !o.includes(marker(i)));
    if (missing.length === 0) break;
    await sleep(200);
  }
  const missing = [...outputs.entries()].filter(([i, o]) => !o.includes(marker(i))).map(([i]) => i);

  // scrollback buffers hold the data too
  const sbMissing: number[] = [];
  for (let i = 0; i < N; i++) {
    if (!service.get(`check-${i}`)!.scrollback.snapshot().toString().includes(marker(i))) {
      sbMissing.push(i);
    }
  }

  service.killAll();
  const killDeadline = Date.now() + 10000;
  while (Date.now() < killDeadline && exits.size < N) await sleep(200);

  const stillAlive = service.list().filter((s) => s.exitCode === null);
  const ok = missing.length === 0 && sbMissing.length === 0 && stillAlive.length === 0;
  console.log(
    `[pty-check] markers=${N - missing.length}/${N} scrollback=${N - sbMissing.length}/${N} ` +
      `exited=${exits.size}/${N} stillAlive=${stillAlive.length}`
  );
  console.log(ok ? '[pty-check] PASS' : `[pty-check] FAIL missing=${missing} sb=${sbMissing}`);
  return ok ? 0 : 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[pty-check] ERROR', err);
    process.exit(1);
  }
);
