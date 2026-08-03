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
const { spawn } = require('child_process');
const path = require('path');
const { createAttachConsoleFilter } = require('./pty-noise-filter');

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

module.exports = { runFiltered };

if (require.main === module) {
  const electron = require('electron'); // plain-node require -> path to binary
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.NoDefaultCurrentDirectoryInExePath;

  runFiltered(electron, process.argv.slice(2), {
    env,
    cwd: path.join(__dirname, '..'),
    rawStderr: process.env.RUN_ELECTRON_NODE_RAW_STDERR === '1',
  }).then((code) => {
    // exitCode, not process.exit(): exiting here can truncate stderr when it is
    // redirected to a file or a pipe. Nothing else holds the loop open.
    process.exitCode = code;
  });
}
