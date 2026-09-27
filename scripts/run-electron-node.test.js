// #176 — five `check:*` scripts run through run-electron-node.js, so its exit
// code IS their exit code. That contract used to be one `spawnSync` line; it is
// now an async spawn with a piped stderr, which is a lot more surface for a
// check to start silently passing on. These tests drive `runFiltered` with plain
// `node` (NOT the Electron binary — CI's unit job installs no Electron system
// libs on Linux) so the plumbing is covered on all three OSes.
//
// #952 REMOVED THE FILTERING, NOT THE CONTRACT. The two cases that pinned the
// node-pty `AttachConsole` dump are gone with node-pty itself. Everything else
// here survives unchanged, because it was never about the filter: an exit code,
// a missing binary, the last bytes of a child that exits immediately, and a
// grandchild holding the write end open are properties of spawning, and they are
// what the five checks actually ride on.
import { describe, it, expect } from 'vitest';
import { execPath } from 'process';
import { runFiltered } from './run-electron-node.js';

/** run a snippet under plain node, capturing what reaches our stderr sink */
async function run(source, opts = {}) {
  let err = '';
  const code = await runFiltered(execPath, ['-e', source], {
    stdout: 'ignore',
    write: (s) => {
      err += s;
    },
    ...opts,
  });
  return { code, err };
}

describe('runFiltered — the contract five check:* scripts exit through (#176)', () => {
  it('propagates a clean exit', async () => {
    expect(await run('process.exit(0)')).toEqual({ code: 0, err: '' });
  });

  it('propagates a failing exit code, not just non-zero', async () => {
    const r = await run('process.exit(3)');
    expect(r.code).toBe(3);
  });

  it('resolves 1 and reports when the binary does not exist', async () => {
    // e.g. a broken Electron install: must fail loudly, never hang
    const code = await runFiltered('this-binary-does-not-exist-176', [], {
      stdout: 'ignore',
      write: () => {},
    });
    expect(code).toBe(1);
  });

  it('forwards stderr verbatim — nothing is added, nothing is swallowed', async () => {
    // This is what replaced the two filter tests (#952): the pipe's remaining
    // job is to be transparent, and a filter re-introduced by accident would
    // fail here rather than silently eat a real error.
    const r = await run(
      "process.stderr.write('Error: the thing that actually broke\\n');" + 'process.exit(1)'
    );
    expect(r.code).toBe(1);
    expect(r.err).toBe('Error: the thing that actually broke\n');
  });

  it('adds no note to an ordinary warning', async () => {
    const r = await run("process.stderr.write('just a normal warning\\n')");
    expect(r.err).toBe('just a normal warning\n');
  });

  it('rawStderr restores plain inheritance — nothing reaches our sink', async () => {
    // the escape hatch: stderr is inherited, so it bypasses our pipe entirely
    // and nothing reaches our `write` sink. (One marker line: it lands in this
    // run's real stderr.)
    const r = await run("process.stderr.write('#176 raw passthrough\\n'); process.exit(7)", {
      rawStderr: true,
    });
    expect(r.code).toBe(7);
    expect(r.err).toBe('');
  });

  it('does not lose the last bytes of stderr when the child exits immediately', async () => {
    const r = await run("process.stderr.write('final byte marker\\n'); process.exit(2)");
    expect(r).toEqual({ code: 2, err: 'final byte marker\n' });
  });

  it('never hangs when a grandchild outlives the child holding stderr open', async () => {
    // `close` waits for EVERY holder of the pipe's write end, so a detached
    // grandchild could pin it forever; the drain timer is the bound. (On
    // Windows the named pipe releases with the child, so this resolves via
    // `close` there and via the timer on POSIX — either way it must resolve.)
    const source =
      "require('child_process').spawn(process.execPath," +
      " ['-e', 'setTimeout(()=>{}, 30000)'], { detached: true, stdio: ['ignore','ignore', 2] })" +
      '.unref(); process.exit(0)';
    const r = await run(source, { drainMs: 300 });
    expect(r.code).toBe(0);
    // This one stays BELOW the suite ceiling on purpose: the grandchild it
    // strands lives 30 s, so a 30 s test would let a regressed `runFiltered`
    // resolve on the grandchild's death and pass. 10 s is the assertion.
  }, 10000);
  // Suite ceiling, 30 s rather than vitest's 5 s default: every case spawns
  // a real node, and #512 is what that costs on a loaded Windows runner —
  // a test that runs in well under a second locally took 7123 ms there.
}, 30_000);
