// P2-E11-12: the `fork` capability and `--fork-session` (§5.5 Level 3).
//
// A separate file from `claude-mcp.test.ts` for that file's own reason: the
// load-bearing assertions here are about what CANNOT happen — a fake reaching
// the fork path, an unpinned fork spawning anyway, a lone `--fork-session` — and
// negatives deserve to be findable.
//
// The CONTRACT these pin was measured, not assumed: `spike/probes/801/` drove
// claude 2.1.272 and `spike/findings/e11-801-fork-adoption.md` records what came
// back. These tests pin our side of it.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { AUTONOMY_PERMISSION_MODE, claudeAdapter, resetCliPathCache } from './claude';
import { fakeAdapter } from './fake';
import { fakeStreamAdapter } from './fake-stream';
import { slugForCwd } from '../transcripts/paths';
import type { SpawnOptions } from '../extensibility/contributions';

/** A real UUID — the CLI validates `--session-id` and refuses anything else. */
const FORK_ID = '9eba5fec-dc28-47f9-b032-21b76ab84673';

let tmp: string;
let origPath: string | undefined;
beforeEach(() => {
  tmp = tempDir('sb-claude-fork-');
  origPath = process.env.PATH;
  resetCliPathCache();
});
afterEach(() => {
  if (origPath === undefined) delete process.env.PATH;
  else process.env.PATH = origPath;
  cleanupTempDirs();
});

function withCliOnPath(): string {
  const name = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const cli = path.join(tmp, name);
  fs.writeFileSync(cli, 'stub');
  process.env.PATH = tmp + path.delimiter + (process.env.PATH ?? '');
  return cli;
}

function spawn(opts: Partial<SpawnOptions>): string[] {
  withCliOnPath();
  return claudeAdapter.buildSpawn({
    cwd: tmp,
    sessionId: 's',
    stateDir: path.join(tmp, 'st'),
    ...opts,
  }).args;
}

describe('the `fork` capability is the gate (§5.3, §5.5 Level 3)', () => {
  it('is declared by the real adapter', () => {
    expect(claudeAdapter.capabilities?.fork).toBeDefined();
  });

  // ── THE NEGATIVE THAT IS THE WHOLE POINT ──────────────────────────────────
  //
  // #801's done-when: "a provider without the capability, and any non-Claude
  // adapter, cannot reach this path at all". Both fakes register under the SAME
  // provider id as the real adapter (`claude-code`), so no id check could tell
  // them apart — this absence is the only thing standing between the e2e
  // harness and a real `--fork-session` argv. If someone "tidies up" the fakes
  // to mirror the real adapter again, this is what goes red.
  it.each([
    ['pty fake', fakeAdapter],
    ['stream fake', fakeStreamAdapter],
  ])('is NOT declared by the %s — the absence IS the gate', (_label, adapter) => {
    expect(adapter.capabilities?.fork).toBeUndefined();
    // ...and they are otherwise still mirrors, so this is a deliberate single
    // exception rather than a fake that drifted. A fake missing `resume` too
    // would mean something else broke.
    expect(adapter.capabilities?.resume).toBeDefined();
    expect(adapter.capabilities?.transcripts).toBeDefined();
  });

  it('asks about the SOURCE folder, not the folder the session will run in', () => {
    // The cross-folder case is the entire feature, and this is the mistake that
    // would break it while looking correct on every same-folder test: Claude's
    // layout derives the transcript directory from the folder path, so asking
    // about the TARGET looks in a directory the source transcript is not in.
    const root = path.join(tmp, 'projects');
    const sourceFolder = path.join(tmp, 'project-a');
    const targetFolder = path.join(tmp, 'project-b');
    const dir = path.join(root, slugForCwd(sourceFolder));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'conv-1.jsonl'), '{}\n');

    const fork = claudeAdapter.capabilities!.fork!;
    expect(
      fork.canFork({ projectsRoot: root, sourceFolder, sourceSessionId: 'conv-1' })
    ).toBe(true);
    // the same conversation, asked about from the target's folder: not there
    expect(
      fork.canFork({ projectsRoot: root, sourceFolder: targetFolder, sourceSessionId: 'conv-1' })
    ).toBe(false);
  });

  it('says no for a conversation that is not on disk', () => {
    expect(
      claudeAdapter.capabilities!.fork!.canFork({
        projectsRoot: path.join(tmp, 'projects'),
        sourceFolder: tmp,
        sourceSessionId: 'nope',
      })
    ).toBe(false);
  });
});

describe('claudeAdapter.buildSpawn — the fork flags', () => {
  it('passes --fork-session and --session-id, AFTER --resume', () => {
    const args = spawn({ resumeSessionId: 'native-1', forkSession: true, forkSessionId: FORK_ID });
    // Order, not just presence: `--fork-session` is documented as modifying a
    // resume, and the CLI's own launcher builds the pair this way.
    expect(args.slice(0, 5)).toEqual([
      '--resume',
      'native-1',
      '--fork-session',
      '--session-id',
      FORK_ID,
    ]);
    expect(args).toEqual([
      '--resume',
      'native-1',
      '--fork-session',
      '--session-id',
      FORK_ID,
      '--permission-mode',
      AUTONOMY_PERMISSION_MODE.ask,
    ]);
  });

  it('passes NEITHER flag when there is no conversation to fork from', () => {
    // `--fork-session` is "use with --resume or --continue" (the CLI's own help).
    // A lone one is a bug upstream, and passing it would hide that bug behind a
    // session that starts and silently is not a fork.
    const args = spawn({ forkSession: true, forkSessionId: FORK_ID });
    expect(args).not.toContain('--fork-session');
    expect(args).not.toContain('--session-id');
  });

  it('passes neither flag on an ordinary resume', () => {
    const args = spawn({ resumeSessionId: 'native-1' });
    expect(args).toEqual(['--resume', 'native-1', '--permission-mode', AUTONOMY_PERMISSION_MODE.ask]);
  });

  // ── THE REFUSAL THAT PROTECTS THE CARD BINDING ────────────────────────────
  //
  // An unpinned fork still RUNS — it just mints an id we only learn afterwards,
  // and until it arrives the card's only candidate is the SOURCE id. That binds
  // two cards to one transcript (#484/#539). Throwing costs a session that does
  // not start, which is recoverable; the alternative is not.
  it.each([
    ['absent', undefined],
    ['not a uuid', 'not-a-uuid'],
    ['empty', ''],
    ['a conversation id that is not a uuid', 'conv-1'],
    ['a uuid with a leading dash', '-9eba5fec-dc28-47f9-b032-21b76ab84673'],
  ])('REFUSES to spawn a fork whose session id is %s', (_label, forkSessionId) => {
    expect(() =>
      spawn({ resumeSessionId: 'native-1', forkSession: true, forkSessionId })
    ).toThrow(/valid UUID/i);
  });

  it('accepts an upper-case UUID, because the CLI does', () => {
    // The CLI's own regex carries the `i` flag. Being stricter than the thing we
    // are protecting would refuse ids the CLI would have taken — our bug wearing
    // the CLI's clothes.
    const args = spawn({
      resumeSessionId: 'native-1',
      forkSession: true,
      forkSessionId: FORK_ID.toUpperCase(),
    });
    expect(args).toContain(FORK_ID.toUpperCase());
  });

  it('forks on the stream transport too — the app default', () => {
    // Round 2 of the probe measured exactly this combination against the real
    // CLI, because round 1 only drove `-p` and the app does not spawn that way.
    const args = spawn({
      transport: 'stream',
      resumeSessionId: 'native-1',
      forkSession: true,
      forkSessionId: FORK_ID,
    });
    expect(args).toContain('--output-format');
    expect(args.slice(-5)).toEqual([
      '--fork-session',
      '--session-id',
      FORK_ID,
      '--permission-mode',
      AUTONOMY_PERMISSION_MODE.ask,
    ]);
  });
});
