// #793 probe — TERMINAL MODE (interactive TUI in a PTY). After /clear, is the
// first hook carrying the NEW conversation id `SessionStart source:'clear'`?
//
// Why this mode matters most: in CLI 2.1.270 the ONLY caller that passes
// `deferSessionStartHooks` to the clear function is the interactive TUI host,
// so here SessionStart(clear) is QUEUED and the function returns without
// awaiting it. And a Terminal-mode session has no stream pump: the hook
// listener is the only writer of the native id, so there is no init to fall
// back on if an untagged hook wins.
//
// Recipe from the July /clear probe (.claude/work_files/clear-probe/): temp
// HOME with copied credentials + a trusted temp project, scrubbed immediately;
// PTY write pattern "text, CR 75 ms later" (what the app ships, proven to
// execute slash commands). Hooks POST to a local receiver; arrival timed with
// Date.now(). Turn completion = the Stop hook.
//
// Scenarios, TRIALS each (default 5):
//   A  say ok → wait for Stop → /clear alone
//   B  say ok → wait for Stop → /clear, then IMMEDIATELY say ok
//   C  /clear as the first input
//   G  (optional) a background shell that is still running across /clear:
//      "run `sleep 20` in the background" → /clear → wait for its hooks
//
// Run from the repo root: node spike/probes/793/probe-clear-order-pty.cjs
// (needs node-pty loadable by the node running it).
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

const TRIALS = Number(process.env.TRIALS || 5);
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'SubagentStop', 'Stop', 'PreToolUse'];
const CR = String.fromCharCode(13);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findClaude() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of ['claude.cmd', 'claude.exe', 'claude']) {
      const full = path.join(dir, n);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {}
    }
  }
  throw new Error('claude not on PATH');
}

function makeHome(projectDir) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb793pty-home-'));
  const realHome = process.env.USERPROFILE || process.env.HOME || os.homedir();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  for (const rel of ['.claude.json', path.join('.claude', '.credentials.json')]) {
    const src = path.join(realHome, rel);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(home, rel));
  }
  const cfgPath = path.join(home, '.claude.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  cfg.projects = cfg.projects || {};
  cfg.projects[projectDir.replace(/\\/g, '/').replace(/\/+$/, '')] = {
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount: 1,
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  return home;
}

let sink = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const at = Date.now();
    try {
      const e = JSON.parse(body);
      sink && sink.push({ at, kind: 'hook', event: e.hook_event_name, source: e.source || null, id: e.session_id || null });
    } catch {
      sink && sink.push({ at, kind: 'hook', unparseable: true });
    }
    res.writeHead(200);
    res.end('{}');
  });
});

const waitFor = (pred, timeoutMs) =>
  new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      const v = pred();
      if (v || Date.now() - start > timeoutMs) {
        clearInterval(t);
        resolve(v || null);
      }
    }, 50);
  });

async function type(p, events, text) {
  events.push({ at: Date.now(), kind: 'sent', text });
  p.write(text);
  await sleep(75);
  p.write(CR);
}

async function runTrial(port, scenario, n) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `sb793pty-${scenario}-`));
  const home = makeHome(projectDir);
  const fwd = path.join(projectDir, 'fwd.cjs');
  fs.writeFileSync(
    fwd,
    `const http=require('http');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{` +
      `const r=http.request({host:'127.0.0.1',port:${port},method:'POST',path:'/'},x=>{x.resume();x.on('end',()=>process.exit(0))});` +
      `r.on('error',()=>process.exit(0));r.end(s)});`
  );
  const command = `"${process.execPath}" "${fwd}"`;
  const hooks = {};
  for (const ev of EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', timeout: 10, command }] }];
  const settings = path.join(projectDir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks }));

  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  const events = [];
  sink = events;
  const t0 = Date.now();
  const count = (pred) => events.filter((e) => e.kind === 'hook' && pred(e)).length;
  // No permission flag: that is not how the app launches a Terminal session,
  // and `bypassPermissions` can raise a one-time TUI confirmation that would
  // swallow the typed /clear. Scenarios A–C use no tools. G needs one Bash
  // call; if a permission prompt blocks it, the trial reports no Stop and the
  // timeline shows it — it is optional and says so rather than faking consent.
  const p = pty.spawn(findClaude(), ['--settings', settings], {
    name: 'xterm-color',
    cols: 120,
    rows: 30,
    cwd: projectDir,
    env,
  });
  let screen = '';
  p.onData((d) => (screen += d));

  let verdict;
  try {
    const up = await waitFor(() => count((e) => e.event === 'SessionStart'), 30_000);
    if (!up) return { scenario, n, observed: false, note: 'STARTUP-TIMEOUT', screenTail: screen.slice(-400) };
    await sleep(2000); // let the composer settle

    if (scenario === 'A' || scenario === 'B') {
      const stops = count((e) => e.event === 'Stop');
      await type(p, events, 'say ok');
      await waitFor(() => count((e) => e.event === 'Stop') > stops, 60_000);
      await sleep(500);
    }
    if (scenario === 'G') {
      const stops = count((e) => e.event === 'Stop');
      await type(p, events, 'Use the Bash tool with run_in_background to run: sleep 20. Then reply ok.');
      await waitFor(() => count((e) => e.event === 'Stop') > stops, 90_000);
      await sleep(500);
    }
    await type(p, events, '/clear');
    if (scenario === 'B') {
      // immediately — no wait for anything
      await type(p, events, 'say ok');
    }
    await sleep(scenario === 'G' ? 30_000 : 10_000);
  } finally {
    sink = null;
    try {
      p.kill();
    } catch {}
    await sleep(800);
    // The temp HOME holds COPIED CREDENTIALS. The smoke run showed a single
    // rmSync can lose the race with the just-killed CLI's file handles and
    // leave the directory behind. So: unlink the two secret files by name
    // first, then retry the directory, and say so loudly if anything survives.
    const secrets = [path.join(home, '.claude.json'), path.join(home, '.claude', '.credentials.json')];
    const survivors = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      for (const f of secrets) {
        try {
          fs.rmSync(f, { force: true });
        } catch {}
      }
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {}
      if (!fs.existsSync(home)) break;
      await sleep(500);
    }
    for (const f of secrets) if (fs.existsSync(f)) survivors.push(f);
    if (fs.existsSync(home)) survivors.push(home);
    if (survivors.length) process.stderr.write(`!! CLEANUP: still on disk: ${survivors.join(', ')}\n`);
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        fs.rmSync(projectDir, { recursive: true, force: true });
      } catch {}
      if (!fs.existsSync(projectDir)) break;
      await sleep(500);
    }
  }

  const clearAt = (events.find((e) => e.kind === 'sent' && e.text === '/clear') || {}).at || Infinity;
  const oldIds = new Set(events.filter((e) => e.at < clearAt && e.id).map((e) => e.id));
  const hooksAfter = events.filter((e) => e.kind === 'hook' && e.at >= clearAt && e.id && !oldIds.has(e.id));
  const isTagged = (e) => e.event === 'SessionStart' && e.source === 'clear';
  const clearHook = hooksAfter.find(isTagged);
  const firstNew = hooksAfter[0];
  const firstUntagged = hooksAfter.find((e) => !isTagged(e));
  const rel = (e) => (e ? e.at - clearAt : null);
  const observed = !!clearHook && !events.some((e) => e.unparseable);
  verdict = {
    scenario,
    n,
    observed,
    clearHookMs: rel(clearHook),
    firstNewIdHook: firstNew ? { event: firstNew.event, source: firstNew.source, ms: rel(firstNew) } : null,
    firstUntaggedNewIdHook: firstUntagged ? { event: firstUntagged.event, ms: rel(firstUntagged) } : null,
    untaggedFirst: observed ? !isTagged(firstNew) : null,
    // old-id hooks AFTER /clear: a background task still reporting under the old id
    oldIdHooksAfterClear: events
      .filter((e) => e.kind === 'hook' && e.at >= clearAt && e.id && oldIds.has(e.id))
      .map((e) => ({ event: e.event, ms: rel(e) })),
    timeline: events.map((e) => Object.assign({}, e, { at: e.at - t0 })),
  };
  return verdict;
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const out = [];
  for (const scenario of (process.env.SCENARIOS || 'A,B,C').split(',')) {
    for (let n = 1; n <= TRIALS; n++) {
      const r = await runTrial(port, scenario, n);
      out.push(r);
      process.stderr.write(
        `${scenario}#${n} observed=${r.observed} clearHook=${r.clearHookMs} first=${JSON.stringify(r.firstNewIdHook)} ` +
          `firstUntagged=${JSON.stringify(r.firstUntaggedNewIdHook)} untaggedFirst=${r.untaggedFirst}` +
          (r.note ? ` note=${r.note}` : '') +
          '\n'
      );
    }
  }
  server.close();
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
})();
