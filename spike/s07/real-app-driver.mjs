// P2-E15-14 (#111) — re-measure S-07 concurrency on the REAL app.
//
// Mirrors spike/s07/multi-main.js's methodology (whole-process-tree CPU% and
// working set sampled every 2s via PowerShell, renderer event-loop jank via a
// 100ms timer, phases: spawn -> settle -> idle -> stream) but drives the
// SHIPPED app (out/) through Playwright's Electron launcher instead of a
// harness. Window is maximized + always-on-top for the whole run: the S-07
// N=12 jank number was an occlusion artifact and that trap is not repeatable.
//
// Usage:
//   node driver.mjs --transport=stream --tiers=8,12 --prompts=1
//   node driver.mjs --transport=pty --tiers=12 --prompts=0   (idle only, 0 turns)
import { _electron as electron } from '@playwright/test';
import { createRequire } from 'module';
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..'); // worktree root

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TRANSPORT = arg('transport', 'stream'); // 'stream' (shipped default) | 'pty'
const TIERS = arg('tiers', '8,12').split(',').map(Number);
const N_MAX = Math.max(...TIERS);
const DO_SINGLE_STREAM = arg('prompts', '1') !== '0'; // one real turn per tier
const DO_BURST = arg('burst', '1') !== '0'; // one real turn per session at N_MAX
const FAKE = arg('fake', '0') === '1'; // dry-run the harness without real turns
const MONACO = arg('monaco', '0') === '1'; // open diff panes (Monaco) — 0 turns
const MONACO_TIERS = arg('monacotiers', '4,12').split(',').map(Number);
const MONACO_MS = Number(arg('monacoms', '60000'));
const TAG = arg('tag', TRANSPORT);
const OUT = path.join(HERE, `report-${TAG}.json`);
const LOG = path.join(HERE, `run-${TAG}.log`);

const SETTLE_MS = Number(arg('settle', '30000'));
const IDLE_MS = Number(arg('idle', '120000'));
const STREAM_MS = Number(arg('stream', '60000'));
const BURST_MS = Number(arg('burstms', '150000'));
const SPAWN_STAGGER_MS = 1500;

const log = (s) => {
  const line = `${new Date().toISOString()} ${s}`;
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ home --- */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-perf111-'));
const folders = [];
function makeProjectFolder(i) {
  // a REAL git repo with a dirty file: per-card git polling is one of the
  // subsystems this item is measuring, and it does nothing in a non-repo.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sb-perf111-proj${i}-`));
  fs.writeFileSync(path.join(dir, 'README.md'), `# perf-111 project ${i}\n`);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  const git = (args) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, HOME: home } });
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'perf@example.com']);
    git(['config', 'user.name', 'perf']);
    git(['add', '.']);
    git(['commit', '-qm', 'init']);
    fs.appendFileSync(path.join(dir, 'a.txt'), 'four\nfive\n'); // dirty worktree
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'x\n');
  } catch (e) {
    log(`git seed failed for ${dir}: ${e}`);
  }
  folders.push(dir);
  return dir;
}

function seedHome() {
  const realHome = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  for (const rel of ['.claude.json', path.join('.claude', '.credentials.json')]) {
    const src = path.join(realHome, rel);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(home, rel));
  }
  // pre-trust the project folders so no session stalls on a trust prompt
  const cfgPath = path.join(home, '.claude.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.projects = cfg.projects ?? {};
    for (const f of folders) {
      for (const key of [f, f.replace(/\\/g, '/')]) {
        cfg.projects[key] = {
          ...(cfg.projects[key] ?? {}),
          allowedTools: [],
          hasTrustDialogAccepted: true,
          projectOnboardingSeenCount: 3,
        };
      }
    }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  } catch (e) {
    log(`could not seed trust: ${e}`);
  }
}

/* --------------------------------------------------------------- sampler --- */
// Identical shape to S-07's: walk the process tree from the Electron MAIN pid,
// sum CPU seconds and working set, derive %-of-one-core from the delta.
let samples = [];
let phase = 'boot';
let lastSample = null;
let rootPid = 0;

function sampleTree(cb) {
  const ps = `
$root=${rootPid}
$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine
$tree=@($root); $added=$true
while($added){ $added=$false
  foreach($p in $all){ if($tree -contains $p.ParentProcessId -and -not ($tree -contains $p.ProcessId)){ $tree+=$p.ProcessId; $added=$true } } }
$cl=@{}; foreach($p in $all){ if($tree -contains $p.ProcessId){ $cl[[int]$p.ProcessId]=$p.CommandLine } }
Get-Process -Id $tree -ErrorAction SilentlyContinue | ForEach-Object {
  $c=$cl[[int]$_.Id]
  $type='other'
  if($c -match '--type=([a-zA-Z-]+)'){ $type=$Matches[1] }
  elseif($_.ProcessName -eq 'electron'){ $type='main' }
  elseif($c -match 'claude'){ $type='cli' }
  elseif($_.ProcessName -eq 'node'){ $type='node' }
  [pscustomobject]@{ id=$_.Id; name=$_.ProcessName; type=$type; cpu=$_.CPU; ws=$_.WorkingSet64 }
} | ConvertTo-Json -Compress`;
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps],
    { maxBuffer: 20e6 },
    (err, stdout) => {
      if (err) return cb(null);
      try {
        const j = JSON.parse(stdout);
        cb(Array.isArray(j) ? j : [j]);
      } catch {
        cb(null);
      }
    }
  );
}

const procSnapshots = {};
function takeSample(nSessions) {
  return new Promise((resolve) => {
    sampleTree((procs) => {
      if (!procs) return resolve(null);
      if (!procSnapshots[phase]) {
        procSnapshots[phase] = procs.map((p) => ({
          name: p.name,
          type: p.type,
          wsMB: Math.round((p.ws || 0) / 1048576),
        }));
      }
      const now = Date.now();
      const totCpu = procs.reduce((a, p) => a + (p.cpu || 0), 0);
      const totWs = procs.reduce((a, p) => a + (p.ws || 0), 0);
      const by = (pred) => procs.filter(pred);
      const sumWs = (a) => Math.round(a.reduce((x, p) => x + (p.ws || 0), 0) / 1048576);
      const sumCpu = (a) => a.reduce((x, p) => x + (p.cpu || 0), 0);
      const cli = by((p) => p.type === 'cli' || p.type === 'node');
      const rend = by((p) => p.type === 'renderer');
      const main = by((p) => p.type === 'main');
      const gpu = by((p) => p.type === 'gpu-process');
      const util = by((p) => p.type === 'utility');
      const s = {
        at: new Date().toISOString(),
        phase,
        n: nSessions,
        nProcs: procs.length,
        cliCount: cli.length,
        totalCpuSeconds: totCpu,
        totalWorkingSetMB: Math.round(totWs / 1048576),
        cpuPctSinceLast: lastSample
          ? Math.round(((totCpu - lastSample.cpu) / ((now - lastSample.at) / 1000)) * 1000) / 10
          : null,
        appCpuSecs: sumCpu([...main, ...rend, ...gpu, ...util]),
        cliCpuSecs: sumCpu(cli),
        mainMB: sumWs(main),
        rendererMB: sumWs(rend),
        gpuMB: sumWs(gpu),
        utilityMB: sumWs(util),
        cliMB: sumWs(cli),
      };
      if (lastSample) {
        const dt = (now - lastSample.at) / 1000;
        s.appCpuPct = Math.round(((s.appCpuSecs - lastSample.app) / dt) * 1000) / 10;
        s.cliCpuPct = Math.round(((s.cliCpuSecs - lastSample.cli) / dt) * 1000) / 10;
      }
      lastSample = { at: now, cpu: totCpu, app: s.appCpuSecs, cli: s.cliCpuSecs };
      samples.push(s);
      resolve(s);
    });
  });
}

/* ----------------------------------------------------------- in-renderer --- */
const PERF_HOOK = () => {
  const w = window;
  w.__perf = { max: 0, n: 0, over16: 0, over50: 0, over100: 0, sum: 0, frames: 0, t0: 0 };
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const d = now - last - 100;
    last = now;
    const p = w.__perf;
    p.n++;
    if (d > 0) p.sum += d;
    if (d > p.max) p.max = d;
    if (d > 16) p.over16++;
    if (d > 50) p.over50++;
    if (d > 100) p.over100++;
  }, 100);
  const raf = () => {
    w.__perf.frames++;
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  w.__perfReset = () => {
    w.__perf = { max: 0, n: 0, over16: 0, over50: 0, over100: 0, sum: 0, frames: 0, t0: performance.now() };
  };
  w.__perfRead = () => ({
    ...w.__perf,
    elapsedMs: performance.now() - w.__perf.t0,
    fps: w.__perf.frames / ((performance.now() - w.__perf.t0) / 1000),
    avgDriftMs: w.__perf.sum / Math.max(1, w.__perf.n),
  });
  // click a session tab, wait for the frame AFTER the switch has painted
  w.__jump = async (idx) => {
    const tabs = [...document.querySelectorAll('.dv-tab')];
    if (!tabs.length) return null;
    const t = tabs[idx % tabs.length];
    const t0 = performance.now();
    t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    t.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return Math.round((performance.now() - t0) * 10) / 10;
  };
  // type one character into the visible composer, measure to the painted frame
  w.__typeLatency = async () => {
    const box = [...document.querySelectorAll('textarea')].find(
      (el) => el.offsetParent !== null && !el.disabled
    );
    if (!box) return null;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    ).set;
    const t0 = performance.now();
    setter.call(box, box.value + 'x');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const dt = Math.round((performance.now() - t0) * 10) / 10;
    setter.call(box, '');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return dt;
  };
};

/* -------------------------------------------------------------- the run --- */
const buildId = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim();
    return { version: pkg.version, sha };
  } catch {
    return {};
  }
})();

const results = {
  item: '#111 P2-E15-14',
  build: buildId,
  startedAt: new Date().toISOString(),
  transport: TRANSPORT,
  machine: { cpus: os.cpus().length, totalMemMB: Math.round(os.totalmem() / 1048576), cpu: os.cpus()[0]?.model },
  phases: {},
  turns: [],
  events: [],
};

async function samplePhase(page, name, ms, n) {
  phase = name;
  await page.evaluate(() => window.__perfReset());
  const start = Date.now();
  log(`PHASE ${name} (n=${n}) for ${ms}ms`);
  const from = samples.length;
  while (Date.now() - start < ms) {
    await takeSample(n);
    await sleep(1500);
  }
  const perf = await page.evaluate(() => window.__perfRead());
  const mine = samples.slice(from).filter((s) => s.cpuPctSinceLast != null);
  const avg = (f) => (mine.length ? Math.round((mine.reduce((a, s) => a + f(s), 0) / mine.length) * 10) / 10 : null);
  const max = (f) => (mine.length ? Math.round(Math.max(...mine.map(f)) * 10) / 10 : null);
  const p = {
    n,
    samples: mine.length,
    durationMs: Date.now() - start,
    cpuPctAvg: avg((s) => s.cpuPctSinceLast),
    cpuPctMax: max((s) => s.cpuPctSinceLast),
    appCpuPctAvg: avg((s) => s.appCpuPct ?? 0),
    cliCpuPctAvg: avg((s) => s.cliCpuPct ?? 0),
    workingSetMBAvg: avg((s) => s.totalWorkingSetMB),
    mainMBAvg: avg((s) => s.mainMB),
    rendererMBAvg: avg((s) => s.rendererMB),
    gpuMBAvg: avg((s) => s.gpuMB),
    utilityMBAvg: avg((s) => s.utilityMB),
    cliMBAvg: avg((s) => s.cliMB),
    cliCount: mine.length ? mine[mine.length - 1].cliCount : null,
    perSessionMB: avg((s) => s.cliMB) != null && n ? Math.round((avg((s) => s.cliMB) / n) * 10) / 10 : null,
    renderer: {
      maxStallMs: Math.round(perf.max * 10) / 10,
      avgDriftMs: Math.round(perf.avgDriftMs * 100) / 100,
      ticks: perf.n,
      over16: perf.over16,
      over50: perf.over50,
      over100: perf.over100,
      fps: Math.round(perf.fps * 10) / 10,
    },
  };
  results.phases[name] = p;
  log(`PHASE ${name} DONE ${JSON.stringify(p)}`);
  return p;
}

async function measureUi(page, label) {
  const jumps = [];
  for (let i = 0; i < 6; i++) {
    const ms = await page.evaluate((idx) => window.__jump(idx), i);
    if (ms != null) jumps.push(ms);
    await sleep(700);
  }
  const types = [];
  for (let i = 0; i < 5; i++) {
    const ms = await page.evaluate(() => window.__typeLatency());
    if (ms != null) types.push(ms);
    await sleep(400);
  }
  const stat = (a) =>
    a.length
      ? {
          n: a.length,
          avg: Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10,
          max: Math.max(...a),
        }
      : null;
  const ui = { jumpMs: stat(jumps), inputMs: stat(types), raw: { jumps, types } };
  results.phases[label] = { ...(results.phases[label] ?? {}), ui };
  log(`UI ${label} ${JSON.stringify(ui)}`);
  return ui;
}

async function addSession(app, page, i, expectTotal) {
  const dir = folders[i];
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  const t0 = Date.now();
  await page.getByRole('button', { name: '+ session' }).first().click();
  await page.waitForFunction(
    (want) => document.querySelectorAll('.dv-tab').length >= want,
    expectTotal,
    { timeout: 60_000 }
  );
  // best-effort: wait for the card to actually have a live session behind it
  try {
    await page.waitForFunction(
      async (want) => {
        const cards = await window.switchboard.sessions.cards();
        return cards.filter((c) => c.liveId).length >= want;
      },
      expectTotal,
      { timeout: 45_000, polling: 1000 }
    );
  } catch {
    log(`session ${i}: no liveId within 45s (continuing)`);
  }
  log(`session ${i} added in ${Date.now() - t0}ms (folder ${dir})`);
  results.events.push({ kind: 'add', i, ms: Date.now() - t0 });
}

async function liveIds(page) {
  return page.evaluate(async () => {
    const cards = await window.switchboard.sessions.cards();
    return cards.map((c) => ({ cardId: c.cardId, liveId: c.liveId, status: c.status }));
  });
}

async function main() {
  // All project folders exist BEFORE the home is seeded, so the trust entries
  // name the paths the sessions will actually run in.
  for (let i = 0; i < N_MAX; i++) makeProjectFolder(i);
  seedHome();
  log(`seeded ${folders.length} git project folders + isolated home ${home}`);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.NoDefaultCurrentDirectoryInExePath;
  delete env.SWITCHBOARD_AUTOCLOSE;
  delete env.SWITCHBOARD_FAKE_PROVIDER;
  delete env.PLAYWRIGHT_TEST;
  delete env.TEST_WORKER_INDEX;
  delete env.TEST_PARALLEL_INDEX;
  delete env.PWDEBUG;
  if (FAKE) env.SWITCHBOARD_FAKE_PROVIDER = '1'; // dry-run lane: no real CLI, no tokens
  env.TEST_ENABLE_SESSION_PERSISTENCE = '1';
  env.SWITCHBOARD_NO_QUIT_CONFIRM = '1';
  env.SWITCHBOARD_UPDATE_FEED = 'off';
  if (TRANSPORT === 'pty') env.SWITCHBOARD_TRANSPORT = 'pty';
  else delete env.SWITCHBOARD_TRANSPORT;
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = path.join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  fs.mkdirSync(env.APPDATA, { recursive: true });
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [ROOT],
    cwd: ROOT,
    env,
  });
  rootPid = app.process()?.pid;
  log(`electron main pid=${rootPid} home=${home} transport=${TRANSPORT}`);
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.maximize();
    w.show();
    w.focus();
    w.setAlwaysOnTop(true, 'screen-saver'); // the S-07 occlusion trap, closed
  });
  await page.evaluate(PERF_HOOK);
  await sleep(3000);
  results.occlusion = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { visible: w.isVisible(), minimized: w.isMinimized(), alwaysOnTop: w.isAlwaysOnTop(), bounds: w.getBounds() };
  });
  log(`window ${JSON.stringify(results.occlusion)}`);

  let created = 0;
  for (const tier of TIERS) {
    while (created < tier) {
      await addSession(app, page, created, created + 1);
      created++;
      await sleep(SPAWN_STAGGER_MS);
    }
    log(`--- tier n=${tier}: settling ${SETTLE_MS}ms`);
    phase = `settle-${tier}`;
    await sleep(SETTLE_MS);
    const cards = await liveIds(page);
    log(`cards at n=${tier}: ${JSON.stringify(cards.map((c) => c.status))}`);
    results.events.push({ kind: 'cards', tier, cards });

    await samplePhase(page, `idle-${tier}`, IDLE_MS, tier);
    await measureUi(page, `idle-${tier}`);

    if (DO_SINGLE_STREAM) {
      const live = (await liveIds(page)).filter((c) => c.liveId);
      const target = live[TIERS.indexOf(tier)]; // a different session per tier
      if (target) {
        log(`TURN single-stream tier=${tier} session=${target.liveId}`);
        results.turns.push({ kind: 'single-stream', tier, at: new Date().toISOString() });
        await page.evaluate(
          (id) =>
            window.switchboard.sessions.submitPrompt(
              id,
              'Count from 1 to 400, one number per line, no commentary.'
            ),
          target.liveId
        );
        await samplePhase(page, `stream1-${tier}`, STREAM_MS, tier);
        await measureUi(page, `stream1-${tier}`);
      } else {
        log(`no live session to prompt at tier ${tier}`);
      }
    }
  }

  // Monaco (the 9MB renderer bundle AR-P2-11 names) — zero real turns: the
  // diff pane is git + Monaco, no CLI involvement. Opened on a growing number
  // of sessions so the per-editor cost is visible.
  if (MONACO) {
    let opened = 0;
    for (const stop of MONACO_TIERS) {
      while (opened < stop) {
        const title = path.basename(folders[opened]);
        try {
          await page
            .locator('nav [draggable="true"]', { hasText: title })
            .first()
            .click({ button: 'right' });
          await page.getByRole('menuitem', { name: 'Open changes' }).click();
          await page.waitForSelector('.dv-active-tab:has-text("diff")', { timeout: 20_000 });
          const entries = page.getByText('a.txt', { exact: true });
          await entries.last().click();
          const want = opened + 1;
          await page.waitForFunction(
            (k) => document.querySelectorAll('.monaco-diff-editor').length >= k,
            want,
            { timeout: 30_000 }
          );
          log(`monaco diff pane ${opened} open`);
        } catch (e) {
          log(`monaco pane ${opened} failed: ${e}`);
        }
        opened++;
        await sleep(1000);
      }
      const editors = await page.evaluate(
        () => document.querySelectorAll('.monaco-diff-editor').length
      );
      log(`--- monaco tier ${stop}: ${editors} diff editors mounted`);
      await samplePhase(page, `monaco-${stop}`, MONACO_MS, N_MAX);
      await measureUi(page, `monaco-${stop}`);
      results.phases[`monaco-${stop}`].editors = editors;
    }
  }

  if (DO_BURST) {
    const live = (await liveIds(page)).filter((c) => c.liveId);
    log(`TURN burst: prompting ${live.length} sessions`);
    phase = `burst-${N_MAX}`;
    for (const c of live) {
      results.turns.push({ kind: 'burst', liveId: c.liveId, at: new Date().toISOString() });
      await page.evaluate(
        (id) =>
          window.switchboard.sessions.submitPrompt(
            id,
            'Count from 1 to 200, one number per line, no commentary.'
          ),
        c.liveId
      );
      await sleep(1000);
    }
    await samplePhase(page, `burst-${N_MAX}`, BURST_MS, N_MAX);
    await measureUi(page, `burst-${N_MAX}`);
    const after = await liveIds(page);
    results.events.push({ kind: 'cards-after-burst', cards: after });
    log(`statuses after burst: ${JSON.stringify(after.map((c) => c.status))}`);
  }

  // post-run: transcripts written under the isolated home?
  try {
    const projRoot = path.join(home, '.claude', 'projects');
    const count = (function walk(d, depth) {
      if (depth > 4 || !fs.existsSync(d)) return 0;
      let n = 0;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) n += walk(path.join(d, e.name), depth + 1);
        else if (e.name.endsWith('.jsonl')) n++;
      }
      return n;
    })(projRoot, 0);
    results.transcriptFiles = count;
    log(`transcript .jsonl files under isolated home: ${count}`);
  } catch (e) {
    log(`transcript scan failed: ${e}`);
  }

  results.samples = samples;
  results.procSnapshots = procSnapshots;
  results.finishedAt = new Date().toISOString();
  results.realTurns = results.turns.length;
  results.home = home;
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  log(`REPORT ${OUT} — real turns: ${results.realTurns}`);

  // teardown: close the app, then reap the tree, then delete temp dirs
  try {
    await app.close();
  } catch (e) {
    log(`close threw: ${e}`);
  }
  await sleep(2000);
  try {
    execFileSync('taskkill', ['/pid', String(rootPid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
  await sleep(1500);
  for (const d of [...folders, home]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (e) {
      log(`could not remove ${d}: ${e}`);
    }
  }
  log('teardown complete');
  process.exit(0);
}

main().catch(async (err) => {
  log(`FATAL ${err?.stack || err}`);
  try {
    results.samples = samples;
    results.error = String(err);
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  } catch {
    /* ignore */
  }
  try {
    if (rootPid) execFileSync('taskkill', ['/pid', String(rootPid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
