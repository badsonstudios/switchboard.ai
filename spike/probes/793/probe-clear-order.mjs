// #793 probe — DIRECT MODE (stream-json). After /clear, can a hook that carries
// the NEW conversation id reach us before `SessionStart source:'clear'`, and
// before the stream's own `system:init` announces that id?
//
// On this path the CLI AWAITS SessionStart(clear) inline (binary 2.1.270: the
// clear function ends `let L=await XB(o,"clear",...)` when no
// `deferSessionStartHooks` is passed, and only the interactive TUI host passes
// one). So the order should be structural here; this measures it. Terminal
// mode, where the hooks ARE deferred, is `probe-clear-order-pty.cjs`.
//
// Everything is timed on ONE clock (Date.now() in this process): hook POST
// arrival at a local server, and stdout frames. Real CLI, real turns ("say ok"
// only). No --bg, so no background sessions; temp cwd removed at the end.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TRIALS = Number(process.env.TRIALS ?? 5);
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'SubagentStop', 'Stop'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── one local receiver for every trial ──────────────────────────────────────
let sink = null; // the current trial's event array
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

function runTrial(scenario, n) {
  return new Promise(async (resolveTrial) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `sb793-${scenario}-`));
    const fwd = path.join(cwd, 'fwd.cjs');
    fs.writeFileSync(
      fwd,
      `const http=require('http');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{` +
        `const r=http.request({host:'127.0.0.1',port:${port},method:'POST',path:'/'},x=>{x.resume();x.on('end',()=>process.exit(0))});` +
        `r.on('error',()=>process.exit(0));r.end(s)});`
    );
    const command = `"${process.execPath}" "${fwd}"`;
    const hooks = Object.fromEntries(EVENTS.map((ev) => [ev, [{ hooks: [{ type: 'command', timeout: 10, command }] }]]));
    const settings = path.join(cwd, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ hooks }));

    const events = [];
    sink = events;
    const t0 = Date.now();
    const ARGS = [
      '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio', '--replay-user-messages', '--include-partial-messages',
      '--permission-mode', 'default', '--settings', settings,
    ];
    const child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/c', 'claude', ...ARGS], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn('claude', ARGS, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

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
        if (m.type === 'system' && m.subtype === 'init') events.push({ at, kind: 'init', id: m.session_id });
        else if (m.type === 'conversation_reset')
          events.push({ at, kind: 'reset', old: m.session_id, next: m.new_conversation_id ?? null });
        else if (m.type === 'result') {
          results++;
          events.push({ at, kind: 'result', id: m.session_id });
          for (const w of waiters.splice(0)) w();
        }
      }
    });
    child.stderr.on('data', () => {});

    const send = (text) => {
      events.push({ at: Date.now(), kind: 'sent', text });
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    };
    // Resolves once `count` results have been seen in total, or on timeout.
    const untilResults = (count, ms) =>
      Promise.race([
        new Promise((r) => {
          const check = () => (results >= count ? r() : waiters.push(check));
          check();
        }),
        sleep(ms),
      ]);

    await sleep(2500);
    if (scenario === 'A' || scenario === 'B') {
      send('say ok');
      await untilResults(1, 60_000);
    }
    send('/clear');
    if (scenario === 'B') {
      send('say ok');
      // /clear produces its own result, so the prompt's is the THIRD in total
      // (review nit: waiting for "the next result" returned on /clear's).
      await untilResults(3, 60_000);
    }
    await sleep(8000); // let late hooks land

    // Kill the TREE first: `child` is cmd.exe, and killing it first leaves
    // `taskkill /T` walking a dead pid while claude.exe lives on.
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    child.stdin.end();
    child.kill();
    sink = null;
    await sleep(500);
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* a handle may linger a moment */
    }

    // ── verdict for this trial ────────────────────────────────────────────
    const clearAt = events.find((e) => e.kind === 'sent' && e.text === '/clear')?.at ?? Infinity;
    const after = events.filter((e) => e.at >= clearAt);
    const reset = after.find((e) => e.kind === 'reset');
    const initsAfter = after.filter((e) => e.kind === 'init');
    const oldIds = new Set(events.filter((e) => e.at < clearAt && e.id).map((e) => e.id));
    if (reset?.old) oldIds.add(reset.old);
    const hooksAfter = after.filter((e) => e.kind === 'hook' && e.id && !oldIds.has(e.id));
    const newId = initsAfter[0]?.id ?? hooksAfter[0]?.id ?? null;
    const clearHook = hooksAfter.find((e) => e.event === 'SessionStart' && e.source === 'clear');
    const firstNewIdHook = hooksAfter[0];
    const firstInit = initsAfter.find((e) => e.id === newId);
    const isTagged = (e) => e.event === 'SessionStart' && e.source === 'clear';
    const rel = (e) => (e ? e.at - clearAt : null);
    // A trial only COUNTS if the thing being ordered was actually observed
    // (review S3): no hook at all, no init, or an unparseable body would
    // otherwise score as "tagged first".
    const observed = !!clearHook && !!firstInit && !events.some((e) => e.unparseable);
    resolveTrial({
      scenario,
      n,
      observed,
      newId,
      resetMs: rel(reset),
      firstInitMs: rel(firstInit),
      clearHookMs: rel(clearHook),
      firstNewIdHook: firstNewIdHook ? { event: firstNewIdHook.event, source: firstNewIdHook.source, ms: rel(firstNewIdHook) } : null,
      firstUntaggedNewIdHook: (() => {
        const u = hooksAfter.find((e) => !isTagged(e));
        return u ? { event: u.event, ms: rel(u) } : null;
      })(),
      // the #793 condition: an UNTAGGED new-id hook lands before the tagged one
      untaggedFirst: observed ? !isTagged(firstNewIdHook) : null,
      untaggedBeatsInit: observed ? !isTagged(firstNewIdHook) && firstNewIdHook.at < firstInit.at : null,
      timeline: events.map((e) => ({ ...e, at: e.at - t0 })),
    });
  });
}

const results = [];
for (const scenario of (process.env.SCENARIOS ?? 'A,B,C').split(',')) {
  for (let n = 1; n <= TRIALS; n++) {
    const r = await runTrial(scenario, n);
    results.push(r);
    process.stderr.write(
      `${scenario}#${n} observed=${r.observed} reset=${r.resetMs} init=${r.firstInitMs} clearHook=${r.clearHookMs} ` +
        `firstUntagged=${JSON.stringify(r.firstUntaggedNewIdHook)} untaggedFirst=${r.untaggedFirst} beatsInit=${r.untaggedBeatsInit}\n`
    );
  }
}
server.close();
process.stdout.write(JSON.stringify(results, null, 2) + '\n');
