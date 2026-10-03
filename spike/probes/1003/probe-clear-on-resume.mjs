// #1003 probe — "I had to clear the conversation twice".
//
// The report's diagnostic bundle shows one exact shape: a card RESUMED a stored
// conversation (`--resume <id>`), nothing was said, and the first `/clear` came
// 5 s later. The log has `prompt-sent`, then `hook:SessionStart` 1.6 s on, and
// NO `stream feed reset` — until the second `/clear` 11 s later, which logged
// TWO resets and TWO transcript rebinds within 800 ms.
//
// #793's scenario C measured "`/clear` as first input" on a FRESH session
// (reset at 15–19 ms). Nothing has measured it on a RESUMED one. This does:
//
//   seed    spawn, `say ok`, take the conversation id from the result, stop
//   resume  spawn with `--resume <id>` and the app's own argv, wait WAIT_MS,
//           send `/clear`, watch GAP_MS, send `/clear` again, watch TAIL_MS
//
// Every stdout frame that is not a token delta is recorded with its arrival
// time on one clock, alongside every hook POST. Real CLI. The only model turn
// is the seed's `say ok`; `/clear` costs none. No `--bg`; temp cwd removed.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TRIALS = Number(process.env.TRIALS ?? 3);
const WAIT_MS = Number(process.env.WAIT_MS ?? 5000);
const GAP_MS = Number(process.env.GAP_MS ?? 10000);
const TAIL_MS = Number(process.env.TAIL_MS ?? 8000);
/** extra `say ok` turns in the seed, to grow the transcript being resumed */
const SEED_TURNS = Number(process.env.SEED_TURNS ?? 1);
/**
 * Hold every hook open this long AFTER it has reported in. The report's machine
 * took ~7 s to finish starting a resumed session and this one takes ~1 s, so
 * this is how the start-up is stretched far enough to send `/clear` inside it.
 */
const HOOK_DELAY_MS = Number(process.env.HOOK_DELAY_MS ?? 0);
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sink = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const at = Date.now();
    try {
      const e = JSON.parse(body);
      sink?.push({ at, kind: 'hook', event: e.hook_event_name, source: e.source ?? null, id: e.session_id ?? null });
    } catch {
      sink?.push({ at, kind: 'hook', unparseable: true });
    }
    res.writeHead(200);
    res.end('{}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// the app's argv, `src/main/providers/claude.ts`
const BASE_ARGS = [
  '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio', '--replay-user-messages', '--include-partial-messages',
  '--permission-mode', 'default',
];

function open(cwd, settings, extra, events) {
  const args = [...BASE_ARGS, '--settings', settings, ...extra];
  const child =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'claude', ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let results = 0;
  const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type === 'stream_event') continue;
      const at = Date.now();
      const e = { at, kind: 'frame', type: m.type };
      if (typeof m.subtype === 'string') e.subtype = m.subtype;
      if (typeof m.session_id === 'string') e.id = m.session_id;
      if (typeof m.new_conversation_id === 'string') e.next = m.new_conversation_id;
      if (m.type === 'user' && m.isReplay === true) e.replay = true;
      if (m.type === 'result' && typeof m.result === 'string') e.text = m.result.slice(0, 60);
      events.push(e);
      if (m.type === 'result') {
        results++;
        for (const w of waiters.splice(0)) w();
      }
    }
  });
  child.stderr.on('data', () => {});
  return {
    send(text) {
      events.push({ at: Date.now(), kind: 'sent', text });
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    },
    untilResults: (count, ms) =>
      Promise.race([
        new Promise((r) => {
          const check = () => (results >= count ? r(true) : waiters.push(check));
          check();
        }),
        sleep(ms).then(() => false),
      ]),
    async close() {
      // the TREE first: `child` is cmd.exe, and killing it first leaves
      // `taskkill /T` walking a dead pid while claude.exe lives on
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      }
      child.stdin.end();
      child.kill();
      await sleep(500);
    },
  };
}

async function runTrial(n) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sb1003-'));
  const fwd = path.join(cwd, 'fwd.cjs');
  fs.writeFileSync(
    fwd,
    `const http=require('http');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{` +
      `const r=http.request({host:'127.0.0.1',port:${port},method:'POST',path:'/'},x=>{x.resume();x.on('end',()=>setTimeout(()=>process.exit(0),${HOOK_DELAY_MS}))});` +
      `r.on('error',()=>process.exit(0));r.end(s)});`
  );
  const command = `"${process.execPath}" "${fwd}"`;
  const hooks = Object.fromEntries(EVENTS.map((ev) => [ev, [{ hooks: [{ type: 'command', timeout: 10, command }] }]]));
  const settings = path.join(cwd, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks }));

  // ── seed ────────────────────────────────────────────────────────────────
  const seedEvents = [];
  sink = seedEvents;
  const seed = open(cwd, settings, [], seedEvents);
  await sleep(2500);
  for (let i = 1; i <= SEED_TURNS; i++) {
    seed.send('say ok');
    await seed.untilResults(i, 90_000);
  }
  await seed.close();
  const seedId = seedEvents.filter((e) => e.kind === 'frame' && e.type === 'result').pop()?.id ?? null;
  if (!seedId) {
    sink = null;
    fs.rmSync(cwd, { recursive: true, force: true });
    return { n, observed: false, why: 'the seed produced no result', seedTimeline: seedEvents };
  }

  // ── resume, then /clear as the first thing said ─────────────────────────
  const events = [];
  sink = events;
  const t0 = Date.now();
  const s = open(cwd, settings, ['--resume', seedId], events);
  await sleep(WAIT_MS);
  s.send('/clear');
  await sleep(GAP_MS);
  s.send('/clear');
  await sleep(TAIL_MS);
  await s.close();
  sink = null;
  try {
    fs.rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* a handle may linger a moment */
  }

  const clears = events.filter((e) => e.kind === 'sent');
  const [c1, c2] = clears.map((e) => e.at);
  const between = (a, b) => events.filter((e) => e.at >= a && e.at < b && e.kind !== 'sent');
  const count = (list, pred) => list.filter(pred).length;
  const isReset = (e) => e.kind === 'frame' && e.type === 'conversation_reset';
  const isResult = (e) => e.kind === 'frame' && e.type === 'result';
  const first = between(c1, c2);
  const second = between(c2, Infinity);
  const firstReset = first.find(isReset);
  return {
    n,
    observed: true,
    seedId,
    beforeFirstClear: between(0, c1).map((e) => ({ ...e, at: e.at - t0 })),
    firstClear: { resets: count(first, isReset), results: count(first, isResult), resetMs: firstReset ? firstReset.at - c1 : null },
    secondClear: { resets: count(second, isReset), results: count(second, isResult) },
    // the reported shape: the first /clear yields no reset, the second yields two
    reproduced: count(first, isReset) === 0 && count(second, isReset) >= 1,
    timeline: events.map((e) => ({ ...e, at: e.at - t0 })),
  };
}

const version = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'claude', process.platform === 'win32' ? ['/c', 'claude', '--version'] : ['--version'], { encoding: 'utf8' }).stdout?.trim();
process.stderr.write(`claude ${version} · WAIT_MS=${WAIT_MS} GAP_MS=${GAP_MS} SEED_TURNS=${SEED_TURNS} HOOK_DELAY_MS=${HOOK_DELAY_MS}\n`);
const results = [];
for (let n = 1; n <= TRIALS; n++) {
  const r = await runTrial(n);
  results.push(r);
  process.stderr.write(
    r.observed
      ? `#${n} first=${JSON.stringify(r.firstClear)} second=${JSON.stringify(r.secondClear)} reproduced=${r.reproduced}\n`
      : `#${n} NOT OBSERVED: ${r.why}\n`
  );
}
server.close();
process.stdout.write(JSON.stringify({ version, WAIT_MS, GAP_MS, SEED_TURNS, HOOK_DELAY_MS, results }, null, 2) + '\n');
