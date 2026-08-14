import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import {
  claudeAdapter,
  claudeProjectsRoot,
  readAiTitle,
  resetCliPathCache,
  scanPath,
  writeSessionSettings,
} from './claude';
import { LATE, REPEAT_HEAVY, REVISED } from '../transcripts/fixtures/ai-title';
import { slugForCwd } from '../transcripts/paths';

let tmp: string;
let origPath: string | undefined;
beforeEach(() => {
  tmp = tempDir('sb-claude-');
  origPath = process.env.PATH;
  resetCliPathCache();
});
afterEach(() => {
  // Captured/restored for the whole file, not just the tests that call
  // `withCliOnPath()` — the prepended dir is the temp dir deleted below, and a
  // PATH entry pointing at a deleted directory has no business outliving the
  // test that made it (#229).
  if (origPath === undefined) delete process.env.PATH;
  else process.env.PATH = origPath;
  cleanupTempDirs(); // one per test, gone at the end of it (#213)
});

describe('scanPath (absolute CLI resolution, S-01 footgun)', () => {
  it('finds the CLI in a PATH dir', () => {
    const name = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    fs.writeFileSync(path.join(tmp, name), 'stub');
    expect(scanPath([tmp, '/nope'].join(path.delimiter))).toBe(path.join(tmp, name));
  });

  it('returns null when absent', () => {
    expect(scanPath(tmp)).toBeNull();
  });
});

describe('writeSessionSettings (S-02 validate-before-spawn)', () => {
  it('writes a per-session file and returns its absolute path', () => {
    const p = writeSessionSettings(tmp, 's1', { hooks: {} });
    expect(path.isAbsolute(p)).toBe(true);
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual({ hooks: {} });
    expect(p).toContain(path.join('s1', 'settings.json'));
  });

  it('rejects malformed hooks shapes (the silent-ignore trap)', () => {
    expect(() => writeSessionSettings(tmp, 's1', { hooks: 'nope' })).toThrow(/hooks/);
    expect(() => writeSessionSettings(tmp, 's1', { hooks: { Stop: [{}] } })).toThrow(/hooks/);
    expect(() =>
      writeSessionSettings(tmp, 's1', { hooks: { Stop: [{ hooks: [{ command: '' }] }] } })
    ).toThrow(/command/);
  });

  it('accepts a valid hook config', () => {
    const p = writeSessionSettings(tmp, 's1', {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node x.js' }] }] },
    });
    expect(fs.existsSync(p)).toBe(true);
  });
});

describe('claudeAdapter.buildSpawn', () => {
  function withCliOnPath(): string {
    const name = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    const cli = path.join(tmp, name);
    fs.writeFileSync(cli, 'stub');
    process.env.PATH = tmp + path.delimiter + (process.env.PATH ?? '');
    return cli;
  }

  it('uses the absolute CLI path, settings + resume args, env scrubs', () => {
    const cli = withCliOnPath();
    const recipe = claudeAdapter.buildSpawn({
      cwd: tmp,
      sessionId: 'sess-1',
      stateDir: path.join(tmp, 'state'),
      resumeSessionId: 'native-123',
      settings: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node x.js' }] }] } },
    });
    expect(recipe.command).toBe(cli);
    expect(path.isAbsolute(recipe.command)).toBe(true);
    const i = recipe.args.indexOf('--settings');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(path.isAbsolute(recipe.args[i + 1])).toBe(true);
    expect(recipe.args).toContain('--resume');
    expect(recipe.args[recipe.args.indexOf('--resume') + 1]).toBe('native-123');
    expect('ELECTRON_RUN_AS_NODE' in recipe.env).toBe(true);
    expect(recipe.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('maps autonomy profiles to permission modes (E6-01)', () => {
    withCliOnPath();
    const argsFor = (autonomy?: 'plan' | 'ask' | 'auto-edit' | 'full-auto') =>
      claudeAdapter.buildSpawn({ cwd: tmp, sessionId: 's', stateDir: path.join(tmp, 'st'), autonomy }).args;
    expect(argsFor('plan')).toEqual(['--permission-mode', 'plan']);
    expect(argsFor('auto-edit')).toEqual(['--permission-mode', 'acceptEdits']);
    expect(argsFor('full-auto')).toEqual(['--permission-mode', 'bypassPermissions']);
    expect(argsFor('ask')).toEqual([]);
    expect(argsFor(undefined)).toEqual([]);
  });

  it('omits --settings when none provided', () => {
    withCliOnPath();
    const recipe = claudeAdapter.buildSpawn({
      cwd: tmp,
      sessionId: 's',
      stateDir: path.join(tmp, 'state'),
    });
    expect(recipe.args).not.toContain('--settings');
  });
});

// P2-E7-06: the `titles` capability. Claude's is the ONLY place in the tree
// that knows the key is called `ai-title`, so this is where the real captured
// lines get parsed.
describe('readAiTitle — the conversation title Claude writes into its transcript', () => {
  const read = claudeAdapter.capabilities!.titles!.titleFrom;

  it('reads every real captured line, in either key order', () => {
    // `aiTitle` comes before `sessionId` on some lines and after it on others,
    // in the same file, on adjacent lines. Verified against the capture rather
    // than asserted about it.
    for (const capture of [REVISED, REPEAT_HEAVY, LATE]) {
      for (const [lineNo, raw] of capture.lines) {
        const title = read(JSON.parse(raw) as Record<string, unknown>);
        expect(title, `${capture.source}:${lineNo}`).toBeTruthy();
      }
    }
    expect(read(JSON.parse(REVISED.lines[0][1]) as Record<string, unknown>)).toBe(
      'Add markdown and file preview windows'
    );
    expect(read(JSON.parse(REVISED.lines[1][1]) as Record<string, unknown>)).toBe(
      'Add markdown and file preview feature'
    );
  });

  it('the exported function and the declared capability are the same reader', () => {
    // Two spellings of the key is how the adapter and its capability drift.
    expect(claudeAdapter.capabilities!.titles!.titleFrom).toBe(readAiTitle);
  });

  it('says nothing about every other kind of line', () => {
    expect(read({ type: 'assistant', message: { content: [] } })).toBeUndefined();
    expect(read({ type: 'user', aiTitle: 'not from a user line' })).toBeUndefined();
    expect(read({})).toBeUndefined();
  });

  it('a renamed or dropped key is simply no title (§5.26 drift)', () => {
    // The key is undocumented. The day a release renames it, this is what every
    // line looks like — and the app then reads exactly as it did before the
    // feature existed.
    expect(read({ type: 'ai-title', conversationTitle: 'renamed' })).toBeUndefined();
    expect(read({ type: 'ai-title' })).toBeUndefined();
    expect(read({ type: 'ai-title', aiTitle: 42 })).toBeUndefined();
    expect(read({ type: 'ai-title', aiTitle: null })).toBeUndefined();
  });

  it('an empty or blank title is no title', () => {
    // A label that renders as empty is indistinguishable from no label, and
    // letting one through would blank a label the CLI had already filled.
    expect(read({ type: 'ai-title', aiTitle: '' })).toBeUndefined();
    expect(read({ type: 'ai-title', aiTitle: '   ' })).toBeUndefined();
    expect(read({ type: 'ai-title', aiTitle: '  spaced  ' })).toBe('spaced');
  });
});

describe('claudeAdapter.capabilities.resume (#432 — the host declares the root)', () => {
  const NATIVE = '11111111-2222-4333-8444-555555555555';
  const ask = (projectsRoot: string, folder: string, nativeSessionId = NATIVE): boolean =>
    claudeAdapter.capabilities!.resume!.canResume({ projectsRoot, folder, nativeSessionId });

  /** the conversation, where the CLI would have written it under `root` */
  function seed(root: string, folder: string): void {
    const dir = path.join(root, slugForCwd(folder));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${NATIVE}.jsonl`), '{}\n');
  }

  it('answers about the root it is HANDED, not one it derives for itself', () => {
    // The pin for the whole item: this used to call `claudeProjectsRoot()`, so
    // the answer was about `~/.claude/projects` no matter what the host had
    // resolved — a second declaration of the root the replay reads (#395).
    const folder = path.join(tmp, 'project');
    const root = path.join(tmp, 'roots');
    seed(root, folder);
    expect(ask(root, folder)).toBe(true);
    // same conversation, a root the host would not read: not resumable, because
    // resuming it would open a card with nothing in it
    expect(ask(path.join(tmp, 'other-roots'), folder)).toBe(false);
  });

  it('no root means no conversation — never a fall-back to the home directory', () => {
    // The conversation IS in `~/.claude/projects`, and the answer is still no.
    // Asserting `false` against an unseeded home would pass under the old
    // implementation too, which is no pin at all — so the home is pointed at a
    // temp dir and seeded, and only a reintroduced `claudeProjectsRoot()` call
    // inside `canResume` can turn this green.
    const home = path.join(tmp, 'home');
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home; // what os.homedir() reads on win32
    try {
      const folder = path.join(tmp, 'project');
      seed(claudeProjectsRoot(), folder);
      expect(claudeProjectsRoot().startsWith(home)).toBe(true); // the seed landed
      expect(ask('', folder)).toBe(false);
      // and the same conversation IS found when the host hands over that root —
      // so the `false` above is about the missing root, not a broken lookup
      expect(ask(claudeProjectsRoot(), folder)).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('a missing conversation under a real root is not resumable', () => {
    const folder = path.join(tmp, 'project');
    const root = path.join(tmp, 'roots');
    seed(root, folder);
    expect(ask(root, folder, '99999999-0000-4000-8000-000000000000')).toBe(false);
  });
});
