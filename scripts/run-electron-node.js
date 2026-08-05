// Run a script under Electron's Node (`ELECTRON_RUN_AS_NODE=1 electron.exe`)
// — required for anything loading native modules built for Electron's ABI
// (node-pty). Usage: node scripts/run-electron-node.js <script> [args...]
//
// stdin/stdout are inherited straight through. stderr is piped so it can go
// through the #176 filter, which drops ONE known-benign node-pty crash dump
// (see scripts/pty-noise-filter.js for what it matches and why that cannot eat
// a real error) and prints a one-line note saying it did. Everything else
// reaches the terminal untouched. `RUN_ELECTRON_NODE_RAW_STDERR=1` turns the
// filter off entirely and restores plain inheritance.
//
// Side effect of the pipe: stdout is still a direct fd but stderr now
// round-trips through this process's event loop and is line-buffered, so in a
// combined log (CI) an error line can appear slightly later relative to stdout
// than it used to. Nothing is lost — only the interleaving moves.
//
// #298 — it also GUARDS the bundle it is about to run. Every `check:*` script
// execs an `out/main/*-check.js` straight out of a build nothing forced to
// happen, which is #286's trap wearing a different hat: a check that fails
// against last hour's bundle reads exactly like a regression in the code you
// just wrote. The guard lives HERE rather than in five package.json entries for
// the reason #182 exists — five wirings are five chances to forget, and the one
// that gets forgotten is the one that rots. Adding a sixth check script gets
// the guard for free; `src/main/check-scripts.test.ts` holds that door shut.
const { spawn } = require('child_process');
const path = require('path');
const { createAttachConsoleFilter } = require('./pty-noise-filter');
const { cleanEnv } = require('./clean-env');
const { guardBundle } = require('./bundle-guard');

/** how long to wait after `exit` for a piped stderr to close before giving up */
const STDERR_DRAIN_MS = 2000;

/**
 * Spawn `command`, filter its stderr, and resolve its exit code. Exported so
 * the exit-code contract five `check:*` scripts depend on is testable without
 * an Electron binary (CI's unit job has no Electron system libs on Linux).
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, rawStderr?: boolean,
 *           stdout?: 'inherit'|'ignore', write?: (s: string) => void,
 *           drainMs?: number }} opts
 * @returns {Promise<number>}
 */
function runFiltered(command, args, opts = {}) {
  const write = opts.write || ((s) => process.stderr.write(s));
  const rawStderr = Boolean(opts.rawStderr);

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: rawStderr ? 'inherit' : ['inherit', opts.stdout || 'inherit', 'pipe'],
      env: opts.env,
      cwd: opts.cwd,
    });

    let filter = null;
    if (!rawStderr && child.stderr) {
      filter = createAttachConsoleFilter(write);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => filter.push(d));
      // A pipe error (the child force-killed mid-write — which check:pty does
      // twelve times) would otherwise be an UNCAUGHT exception, turning a pass
      // into a crash: the exact failure mode this whole change exists to end.
      child.stderr.on('error', () => {});
    }

    let settled = false;
    let drainTimer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (drainTimer) clearTimeout(drainTimer);
      if (filter) {
        filter.end();
        if (filter.suppressed > 0) {
          const orphans = filter.swallowedFooters;
          write(
            `run-electron-node: suppressed ${filter.suppressed} known-benign node-pty ` +
              '"AttachConsole failed" crash dump(s)' +
              (orphans > 0 ? ` + ${orphans} detached "Node.js v…" line(s)` : '') +
              " — node-pty's own kill() race, harmless (#176). " +
              'RUN_ELECTRON_NODE_RAW_STDERR=1 shows them.\n'
          );
        }
      }
      resolve(code);
    };

    child.on('error', (err) => {
      write(`run-electron-node: ${err.message}\n`);
      finish(1);
    });

    // 'close' rather than 'exit': it fires once the piped stderr is fully
    // drained, so the last bytes of a failure are never lost. But 'close' waits
    // for EVERY holder of the write end, including a grandchild that outlived
    // the child, so 'exit' arms a bounded fallback rather than hanging forever.
    child.on('close', (code, signal) => finish(signal ? 1 : (code ?? 1)));
    child.on('exit', (code, signal) => {
      drainTimer = setTimeout(
        () => {
          if (child.stderr) child.stderr.destroy();
          finish(signal ? 1 : (code ?? 1));
        },
        opts.drainMs ?? STDERR_DRAIN_MS
      );
    });
  });
}

/**
 * Is `script` a build output, i.e. something the bundle guard can speak about?
 *
 * Only `out/` is guarded. This runner is general — pointed at a hand-written
 * `.js` or a scratch file it must stay a plain runner, and a guard that fails
 * because there is no `out/main/index.js` beside a file that never came from a
 * build would be pure noise.
 *
 * @param {string} root project root
 * @param {string|undefined} script argv[2], as typed
 */
function isBuildOutput(root, script) {
  if (!script) return false;
  const rel = path.relative(root, path.resolve(root, script)).replace(/\\/g, '/');
  return rel === 'out' || rel.startsWith('out/');
}

module.exports = { runFiltered, isBuildOutput };

if (require.main === module) {
  // Root from __dirname, not cwd — the same reason bundle-guard.js does it.
  const root = path.join(__dirname, '..');
  const script = process.argv[2];

  // The guard prints its stamp BEFORE electron is spawned, so the verdict sits
  // at the top of the log rather than under a check's own output (#298).
  if (isBuildOutput(root, script) && !guardBundle(root, script, process.env)) {
    process.exitCode = 1;
  } else {
    const electron = require('electron'); // plain-node require -> path to binary
    // the one caller that WANTS run-as-node: cleanEnv strips it, the override
    // puts it back deliberately (scripts/clean-env.js)
    const env = cleanEnv({ ELECTRON_RUN_AS_NODE: '1' });

    runFiltered(electron, process.argv.slice(2), {
      env,
      cwd: root,
      rawStderr: process.env.RUN_ELECTRON_NODE_RAW_STDERR === '1',
    }).then((code) => {
      // exitCode, not process.exit(): exiting here can truncate stderr when it
      // is redirected to a file or a pipe. Nothing else holds the loop open.
      process.exitCode = code;
    });
  }
}
