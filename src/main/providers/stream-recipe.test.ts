// P2-E18-08a — the REAL adapter's stream recipe.
//
// Nobody owned this: every earlier item drove the FAKE, whose buildSpawn needs
// no flags at all. Found while building P2-E18-06 and recorded as a planning
// gap rather than absorbed silently.
//
// The flag list is S-10 §1, read out of the SDK's own argument builder inside
// the VS Code extension bundle — NOT reconstructed from `--help`, whose claim
// that these "only work with --print" is stale (S-10 probe A ran without it).
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { AUTONOMY_PERMISSION_MODE, claudeAdapter, resetCliPathCache } from './claude';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import type { TransportKind } from '../../shared/transport';

let dir: string;
let origPath: string | undefined;

beforeEach(() => {
  dir = tempDir('sb-recipe-');
  resetCliPathCache();
  // a stand-in CLI on PATH, so the adapter can resolve something
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const name = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  fs.writeFileSync(path.join(bin, name), '');
  origPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
});
afterEach(() => {
  // PATH goes back however the test ended (#229). The `bin` we prepended is
  // inside the temp dir deleted on the next line, so leaving it there would
  // hand every later test in this process a PATH entry pointing at nothing —
  // invisible state bleeding across files, the same shape as the leaked
  // directories in #213.
  if (origPath === undefined) delete process.env.PATH;
  else process.env.PATH = origPath;
  cleanupTempDirs(); // one per test, gone at the end of it (#213)
});

function recipe(transport?: TransportKind) {
  return claudeAdapter.buildSpawn({ cwd: dir, sessionId: 's1', stateDir: dir, transport });
}

/** Read `--flag value` pairs and bare flags out of an argv array. */
function flagIndex(args: string[]): Map<string, string | true> {
  const m = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const next = args[i + 1];
    m.set(args[i], next && !next.startsWith('--') ? next : true);
  }
  return m;
}

describe('the stream recipe matches S-10 §1 (P2-E18-08a)', () => {
  it('carries exactly the four flags the SDK builds, with their values', () => {
    const f = flagIndex(recipe('stream').args);

    expect(f.get('--output-format')).toBe('stream-json');
    expect(f.get('--input-format')).toBe('stream-json');
    expect(f.get('--verbose')).toBe(true);
    // The one that MATTERS: it is what makes the CLI delegate can_use_tool
    // instead of drawing its own prompt, and S-09 proved it is silently
    // IGNORED by an interactive TUI session — so it belongs on this branch and
    // nowhere else.
    expect(f.get('--permission-prompt-tool')).toBe('stdio');
  });

  // --print is NOT passed. `--help` says these flags need it; S-10 probe A ran
  // without it and got a long-lived conversation rather than a batch run, which
  // is the entire reason a duplex transport is possible.
  it('does NOT pass --print', () => {
    expect(recipe('stream').args).not.toContain('--print');
    expect(recipe('stream').args).not.toContain('-p');
  });

  // P2-E18-06's criterion, which landed here because the flag had nowhere to
  // live until the recipe existed.
  it('asks for the user-message replay, so a send is acknowledged not assumed', () => {
    expect(recipe('stream').args).toContain('--replay-user-messages');
  });

  it('declares the transport it built for, so the host routes correctly', () => {
    expect(recipe('stream').transport).toBe('stream');
  });
});

describe('the PTY recipe is untouched (P2-E18-08a)', () => {
  it('a PTY request carries none of the stream flags', () => {
    const args = recipe('pty').args;
    for (const flag of [
      '--output-format',
      '--input-format',
      '--verbose',
      '--permission-prompt-tool',
      '--replay-user-messages',
    ]) {
      expect(args).not.toContain(flag);
    }
  });

  // Every pre-E18 caller passes nothing, and must keep getting a PTY.
  it('asking for NOTHING is a PTY recipe with no transport declared', () => {
    const r = recipe(undefined);
    expect(r.transport).toBeUndefined();
    expect(r.args).not.toContain('--output-format');
  });

  it('the S-01 env scrub is on both branches', () => {
    for (const t of ['pty', 'stream'] as const) {
      expect(recipe(t).env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(recipe(t).env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    }
  });
});

describe('stream composes with the other flags (P2-E18-08a)', () => {
  it('resume still works in stream mode', () => {
    const args = claudeAdapter.buildSpawn({
      cwd: dir,
      sessionId: 's1',
      stateDir: dir,
      transport: 'stream',
      resumeSessionId: 'conv-1',
    }).args;

    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('conv-1');
    expect(args).toContain('--output-format');
  });

  it('autonomy still maps to a permission mode in stream mode', () => {
    const args = claudeAdapter.buildSpawn({
      cwd: dir,
      sessionId: 's1',
      stateDir: dir,
      transport: 'stream',
      autonomy: 'auto-edit',
    }).args;

    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args).toContain('--permission-prompt-tool');
  });

  it('gives every autonomy the SAME permission mode on both transports (#587)', () => {
    // The two transports build their args in one place but down different
    // branches. `ask` in particular must not mean "Manual" on one and "whatever
    // the CLI defaults to this month" on the other.
    for (const autonomy of ['plan', 'ask', 'auto-edit', 'full-auto'] as const) {
      const modeOn = (transport?: 'stream') => {
        const args = claudeAdapter.buildSpawn({
          cwd: dir,
          sessionId: 's1',
          stateDir: dir,
          transport,
          autonomy,
        }).args;
        return args[args.indexOf('--permission-mode') + 1];
      };
      expect(modeOn('stream')).toBe(modeOn(undefined));
      expect(modeOn('stream')).toBe(AUTONOMY_PERMISSION_MODE[autonomy]);
    }
  });
});
