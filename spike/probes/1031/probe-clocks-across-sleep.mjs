// PROBE (#1031) — does the monotonic clock stop when this laptop sleeps?
//
// `cpu-heartbeat.ts` now logs a gap between wall-clock and monotonic drift, and
// reads a gap as "wall time the monotonic clock did not see". Whether that
// signal actually appears on THIS machine depends on something nobody has
// measured:
//
//   - across **S3** sleep, Windows' QueryPerformanceCounter does not advance, so
//     the gap appears and the gauge works as designed;
//   - across **modern standby (S0ix)** the SoC stays powered and the counter
//     keeps ticking, so wall and monotonic advance together and NO gap appears.
//
// That matters because signature A in #1003 — 3-4s of drift, no `resume` event,
// laptop only — is more consistent with modern standby than with S3. If so, the
// case that motivated the gauge is the case it is blind to, and the docblock
// should say that rather than implying a two-way discriminator.
//
// ⚠️ THIS CANNOT BE RUN ON THE DESKTOP AND CANNOT BE AUTOMATED. It needs a real
// sleep cycle on the owner's laptop. It is parked here with its instructions so
// whoever has the machine can settle it in five minutes.
//
// HOW TO RUN IT
//   1. On the LAPTOP: `node spike/probes/1031/probe-clocks-across-sleep.mjs`
//   2. Leave it printing. Close the lid (or Start > Power > Sleep).
//   3. Wait at least 60 seconds. Open it again.
//   4. Repeat for the OTHER sleep kind if the machine offers both:
//      `powercfg /a` lists what this hardware supports ("Standby (S0 Low Power
//      Idle)" is modern standby; "Standby (S3)" is the classic one).
//   5. Read the WAKE line it prints and paste it into #1031.
//
// WHAT TO LOOK FOR
//   wallMs >> monoMs   -> the counter stopped. The gauge works on this machine.
//   wallMs ~= monoMs   -> the counter kept running. The gauge is blind to this
//                         sleep kind, and the docblock's warning is the truth.

const TICK_MS = 1_000;
/** a gap this big between the two clocks is a sleep, not scheduling jitter */
const SLEEP_MS = 5_000;

let lastWall = Date.now();
let lastMono = performance.now();

console.log('watching. sleep the machine, wake it, and read the WAKE line.');
console.log(`platform=${process.platform} node=${process.versions.node}`);

setInterval(() => {
  const wall = Date.now();
  const mono = performance.now();
  const wallMs = wall - lastWall;
  const monoMs = mono - lastMono;
  lastWall = wall;
  lastMono = mono;

  // Only the interesting tick prints a verdict. A watcher that logged every
  // second would bury the one line this probe exists to produce.
  if (wallMs > SLEEP_MS || monoMs > SLEEP_MS) {
    const gap = Math.round(wallMs - monoMs);
    const verdict =
      gap > SLEEP_MS / 2
        ? 'COUNTER STOPPED — wall advanced and monotonic did not. The gauge sees this.'
        : 'COUNTER KEPT RUNNING — both advanced together. The gauge is BLIND to this.';
    console.log(
      `WAKE at ${new Date(wall).toISOString()}: wallMs=${Math.round(wallMs)} ` +
        `monoMs=${Math.round(monoMs)} gap=${gap}\n  ${verdict}`
    );
  }
}, TICK_MS);
