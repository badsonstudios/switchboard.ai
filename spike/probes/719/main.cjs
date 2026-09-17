// Probe 719 — is app.getAppMetrics() usable as a CPU heartbeat ON WINDOWS,
// what is its UNIT, and what does one sample actually COVER?
//
// #719 ships a per-process CPU heartbeat to a machine we cannot reproduce on,
// so the heartbeat has exactly one chance to be right. Electron's own typing
// says of CPUUsage.cumulativeCPUUsage: "Will always return 0 on Windows"
// (node_modules/electron/electron.d.ts:7359). The target machine is a Windows
// laptop. If percentCPUUsage carried the same defect the heartbeat would ship
// a column of zeroes and we would learn nothing from occurrence 4.
//
// So this measures, rather than trusting:
//   1. does percentCPUUsage report NON-ZERO on Windows;
//   2. does it ATTRIBUTE correctly — a renderer told to burn a core must be
//      the process that reads high, not the main process;
//   3. is cumulativeCPUUsage really 0 here;
//   4. WHAT IS 100? Run 1 showed a renderer in a hard infinite loop — one fully
//      pegged core — reading only 3.1%. That is ~1/32, the shape of a figure
//      normalised by logical-core count. This matters more than the rest
//      combined: if a pegged core reads 3%, a threshold picked by eye on a big
//      desktop would never fire on a laptop, and the ONE capture we get from
//      occurrence 4 would look like an idle machine. Burner count is a
//      parameter and the probe checks LINEARITY: N burners should read N× one.
//   5. WHAT DOES A SAMPLE COVER? percentCPUUsage is documented (for the process
//      module's getCPUUsage) as "since the last call". The heartbeat will call
//      it once a minute, not once a second. If a sample describes the whole gap
//      it is an average over the minute — ideal. If it describes some short
//      internal window it is an instantaneous reading that can miss a burst
//      entirely. Sample interval is therefore a parameter too, and a long
//      interval must still report the burners at full strength.
//
// It also samples an event-loop lag gauge, because the heartbeat wants one and
// "how frozen are we" is the other half of the #719 question.
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

/** seconds to sample for; arg 1, default 12 */
const DURATION_S = Number(process.argv[2]) || 12;
/** how many core-pegging renderers to run; arg 2, default 1 */
const BURNERS = Number(process.argv[3]) || 1;
/** ms between getAppMetrics() calls; arg 3, default 1000 */
const SAMPLE_MS = Number(process.argv[4]) || 1000;
/** the lag gauge's own tick — drift against this is the measurement */
const LAG_TICK_MS = 200;

/** every sample, so the verdict is computed over the run rather than the last tick */
const samples = [];
let maxLagMs = 0;
/** cost of the getAppMetrics() call itself — it runs on the main thread */
let maxCallMs = 0;

/**
 * A renderer that pegs one core, with backgroundThrottling OFF.
 *
 * Chromium throttles hidden/background renderers hard. A probe that measured a
 * throttled renderer would report a small number and we would wrongly conclude
 * percentCPUUsage under-reports, so the throttle is disabled and the window is
 * shown rather than hidden.
 */
function spawnBurner(i) {
  const html = `<!doctype html><meta charset="utf-8"><title>probe-719-burner-${i}</title>
<body style="font:14px system-ui;padding:1em">probe 719 burner ${i}: burning a core on purpose.
<script>while (true) { Math.sqrt(Math.random()); }</script>`;

  const win = new BrowserWindow({
    width: 380,
    height: 120,
    x: 40 + i * 40,
    y: 40 + i * 40,
    show: true,
    title: `probe-719-burner-${i}`,
    webPreferences: { backgroundThrottling: false },
  });
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return win;
}

function sample() {
  const t0 = performance.now();
  const raw = app.getAppMetrics();
  const callMs = performance.now() - t0;
  if (callMs > maxCallMs) maxCallMs = callMs;

  const metrics = raw.map((m) => ({
    pid: m.pid,
    type: m.type,
    name: m.name ?? '',
    percent: Number(m.cpu?.percentCPUUsage ?? 0),
    cumulative: Number(m.cpu?.cumulativeCPUUsage ?? 0),
  }));
  samples.push(metrics);

  const tabTotal = metrics.filter((m) => m.type === 'Tab').reduce((a, m) => a + m.percent, 0);
  console.log(
    `[sample ${samples.length}] call=${callMs.toFixed(1)}ms lag_max=${maxLagMs.toFixed(0)}ms  ` +
      `tabs_total=${tabTotal.toFixed(1)}%  ` +
      metrics
        .map((m) => `${m.type}${m.name ? `/${m.name}` : ''}#${m.pid}=${m.percent.toFixed(1)}%`)
        .join('  ')
  );
}

/** max drift of a fixed-period timer = how long something else held the loop */
function startLagGauge() {
  let expected = Date.now() + LAG_TICK_MS;
  const t = setInterval(() => {
    const drift = Date.now() - expected;
    if (drift > maxLagMs) maxLagMs = drift;
    expected = Date.now() + LAG_TICK_MS;
  }, LAG_TICK_MS);
  t.unref?.();
  return t;
}

function verdict() {
  const flat = samples.flat();
  const cores = os.cpus().length;
  const anyNonZero = flat.some((m) => m.percent > 0);
  const anyCumulative = flat.some((m) => m.cumulative > 0);

  const peakOf = (pred) => flat.filter(pred).reduce((a, m) => Math.max(a, m.percent), 0);
  const peakBrowser = peakOf((m) => m.type === 'Browser');
  // Peak of the SUM per sample, not the sum of per-process peaks: the burners
  // ramp at slightly different moments and summing separate peaks overstates.
  const peakTabTotal = samples.reduce(
    (a, s) => Math.max(a, s.filter((m) => m.type === 'Tab').reduce((x, m) => x + m.percent, 0)),
    0
  );
  // The steady state matters more than the peak for question 5: drop the first
  // sample, which is always 0 (nothing to diff against) and would drag a mean.
  const steady = samples.slice(1);
  const meanTabTotal = steady.length
    ? steady.reduce((a, s) => a + s.filter((m) => m.type === 'Tab').reduce((x, m) => x + m.percent, 0), 0) /
      steady.length
    : 0;

  const expectedIfNormalised = (BURNERS / cores) * 100;
  const ratio = expectedIfNormalised > 0 ? peakTabTotal / expectedIfNormalised : 0;
  const meanRatio = expectedIfNormalised > 0 ? meanTabTotal / expectedIfNormalised : 0;

  console.log('\n=== VERDICT ===');
  console.log(`platform                 : ${process.platform} / electron ${process.versions.electron}`);
  console.log(`logical cores            : ${cores}`);
  console.log(`burners (pegged cores)   : ${BURNERS}`);
  console.log(`sample interval          : ${SAMPLE_MS}ms`);
  console.log(`samples                  : ${samples.length}`);
  console.log(`percentCPUUsage non-zero : ${anyNonZero ? 'YES — usable' : 'NO — UNUSABLE, do not ship'}`);
  console.log(`cumulativeCPUUsage seen  : ${anyCumulative ? 'non-zero (typing caveat does NOT hold here)' : 'all zero'}`);
  console.log(`peak Tab TOTAL           : ${peakTabTotal.toFixed(1)}%`);
  console.log(`mean Tab TOTAL (steady)  : ${meanTabTotal.toFixed(1)}%`);
  console.log(`peak Browser (main)      : ${peakBrowser.toFixed(1)}%`);
  console.log(`attribution              : ${peakTabTotal > peakBrowser ? 'CORRECT — burners read highest' : 'WRONG/INCONCLUSIVE'}`);
  console.log('--- the unit question ---');
  console.log(`if share-of-machine, expect : ${expectedIfNormalised.toFixed(1)}%  (${BURNERS}/${cores} cores)`);
  console.log(`if share-of-one-core, expect: ${(BURNERS * 100).toFixed(1)}%`);
  console.log(`peak/normalised ratio    : ${ratio.toFixed(2)}  ${ratio > 0.7 && ratio < 1.4 ? '=> UNIT IS SHARE-OF-MACHINE (100 = every core)' : '=> does NOT match share-of-machine'}`);
  console.log('--- what does one sample cover? ---');
  console.log(`mean/normalised ratio    : ${meanRatio.toFixed(2)}  ${meanRatio > 0.7 ? '=> the sample reflects the whole gap (an average over the interval)' : '=> the sample UNDER-reports over a long gap — it is not an interval average'}`);
  console.log(`getAppMetrics() cost max : ${maxCallMs.toFixed(1)}ms (runs on the main thread)`);
  console.log(`event-loop lag max       : ${maxLagMs.toFixed(0)}ms (main idle; Windows timer floor is ~16ms)`);
}

app.whenReady().then(() => {
  console.log(
    `probe 719: ${BURNERS} burner(s), sampling every ${SAMPLE_MS}ms for ${DURATION_S}s`
  );
  const lag = startLagGauge();
  const burners = Array.from({ length: BURNERS }, (_, i) => spawnBurner(i));
  const timer = setInterval(sample, SAMPLE_MS);

  setTimeout(() => {
    clearInterval(timer);
    clearInterval(lag);
    verdict();
    // destroy() not close(): the renderers are in infinite loops and will not
    // run a beforeunload handler, so a polite close can hang.
    for (const w of burners) if (!w.isDestroyed()) w.destroy();
    app.quit();
  }, DURATION_S * 1000);
});

// A probe that leaves a process behind on the owner machine is the thing the
// standing cleanup rule exists to prevent.
app.on('window-all-closed', () => app.quit());
