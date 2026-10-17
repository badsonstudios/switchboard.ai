import fs, { promises as fsp } from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { SlashCommand } from '../../shared/slash-commands';
import { claudeCommandFiles, findMisplacedSkills, scanSlashCommands } from './claude-command-files';

let root: string;
const cwd = (): string => path.join(root, 'project');
const userDir = (): string => path.join(root, 'home', '.claude');
const roots = () => ({ cwd: cwd(), userClaudeDir: userDir() });

const BUILTINS: SlashCommand[] = [
  { name: 'clear', description: 'Clear conversation history', source: 'builtin' },
];

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function scanByName(builtins: SlashCommand[] = []): Promise<Record<string, SlashCommand>> {
  const list = await scanSlashCommands(roots(), builtins);
  return Object.fromEntries(list.map((c) => [c.name, c]));
}

beforeEach(() => {
  root = tempDir('sb-slash-');
});
// Was a bare `rmSync` — which cleaned up, but THREW on a lock race, and a throw
// from a hook is reported as a failed file with no failing test (#213).
afterEach(() => cleanupTempDirs());

describe('scanSlashCommands', () => {
  it('returns just the builtins when nothing exists on disk', async () => {
    await expect(scanSlashCommands(roots(), BUILTINS)).resolves.toEqual(BUILTINS);
  });

  it('finds project + user commands with frontmatter descriptions', async () => {
    write(
      path.join(cwd(), '.claude', 'commands', 'deploy.md'),
      '---\ndescription: Ship it\n---\nbody'
    );
    write(path.join(userDir(), 'commands', 'scratch.md'), 'no frontmatter at all');
    const byName = await scanByName(BUILTINS);
    expect(byName['deploy']).toMatchObject({ source: 'project-command', description: 'Ship it' });
    expect(byName['scratch']).toMatchObject({ source: 'user-command', description: undefined });
  });

  it('namespaces commands in subdirectories with a colon', async () => {
    write(path.join(cwd(), '.claude', 'commands', 'frontend', 'component.md'), 'x');
    expect(Object.keys(await scanByName())).toContain('frontend:component');
  });

  it('finds skills via SKILL.md, preferring the frontmatter name', async () => {
    write(
      path.join(cwd(), '.claude', 'skills', 'review-code', 'SKILL.md'),
      '---\nname: review\ndescription: Deep review\n---\n'
    );
    write(path.join(userDir(), 'skills', 'notes', 'SKILL.md'), 'no frontmatter');
    // a skills dir entry WITHOUT a SKILL.md is not a skill
    fs.mkdirSync(path.join(cwd(), '.claude', 'skills', 'empty-dir'), { recursive: true });
    const byName = await scanByName();
    expect(byName['review']).toMatchObject({ source: 'project-skill', description: 'Deep review' });
    expect(byName['notes']).toMatchObject({ source: 'user-skill' });
    expect(byName['empty-dir']).toBeUndefined();
  });

  it('a project command shadows a same-named user command but never a builtin', async () => {
    write(path.join(cwd(), '.claude', 'commands', 'deploy.md'), 'p');
    write(path.join(userDir(), 'commands', 'deploy.md'), 'u');
    write(path.join(cwd(), '.claude', 'commands', 'clear.md'), 'impostor');
    const byName = await scanByName(BUILTINS);
    expect(byName['deploy'].source).toBe('project-command');
    expect(byName['clear'].source).toBe('builtin');
  });

  it('fails open: an unreadable cwd still yields the builtins', async () => {
    const broken = { cwd: path.join(root, 'no-such-dir'), userClaudeDir: path.join(root, 'nope') };
    await expect(scanSlashCommands(broken, BUILTINS)).resolves.toEqual(BUILTINS);
  });

  it('malformed frontmatter yields the command without a description', async () => {
    write(path.join(cwd(), '.claude', 'commands', 'odd.md'), '---\n:::not yaml at all\n');
    expect((await scanByName())['odd']).toMatchObject({
      source: 'project-command',
      description: undefined,
    });
  });

  // #145: the scan fails open, which is right — but a SILENT fail-open is
  // indistinguishable from "this project has no commands", and that ambiguity
  // cost a CI flake investigation. Failing open is still the behaviour; saying
  // so is the addition.
  it('a real scan failure is logged, and the scan still fails open', async () => {
    write(path.join(cwd(), '.claude', 'commands', 'deploy.md'), '---\ndescription: Ship it\n---\n');
    const commandsDir = path.join(cwd(), '.claude', 'commands');
    const real = fsp.readdir.bind(fsp);
    const spy = vi.spyOn(fsp, 'readdir').mockImplementation(((dir: string, opts: never) =>
      String(dir) === commandsDir
        ? Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
        : real(dir, opts)) as typeof fsp.readdir);

    const msgs: string[] = [];
    let list: SlashCommand[];
    try {
      list = await scanSlashCommands(roots(), BUILTINS, (m) => msgs.push(m));
    } finally {
      spy.mockRestore(); // never leak the fs mock into the rest of the file
    }

    expect(list).toEqual(BUILTINS); // fail-open: still answers, minus the folder
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain(commandsDir); // WHICH folder…
    expect(msgs[0]).toContain('permission denied'); // …and WHY
  });

  it('says NOTHING when the directories merely do not exist (the common case)', async () => {
    const msgs: string[] = [];
    await scanSlashCommands(roots(), BUILTINS, (m) => msgs.push(m));
    expect(msgs).toEqual([]);
  });

  it('YAML block-scalar descriptions read as NO description, not a "|" glyph', async () => {
    write(
      path.join(cwd(), '.claude', 'skills', 'blocky', 'SKILL.md'),
      '---\nname: blocky\ndescription: >-\n  a folded multi-line\n  description\n---\n'
    );
    expect((await scanByName())['blocky']).toMatchObject({ name: 'blocky', description: undefined });
  });
});

// #1328: the owner's Trading project kept its skills as loose .md files, which
// Claude Code ignores. The popup showed none and said nothing.
describe('findMisplacedSkills', () => {
  it('finds loose .md files in the project AND the user skills folder, sorted', async () => {
    write(path.join(cwd(), '.claude', 'skills', 'issue-tracker.md'), 'body');
    write(path.join(cwd(), '.claude', 'skills', 'alpaca-trading.md'), 'body');
    write(path.join(userDir(), 'skills', 'mine.md'), 'body');
    expect(await findMisplacedSkills(roots())).toEqual([
      { scope: 'project', shownDir: '.claude/skills', files: ['alpaca-trading.md', 'issue-tracker.md'] },
      { scope: 'user', shownDir: '~/.claude/skills', files: ['mine.md'] },
    ]);
  });

  it('the scan still does NOT load them as skills (the CLI decides)', async () => {
    write(path.join(cwd(), '.claude', 'skills', 'alpaca-trading.md'), 'body');
    expect(await scanByName()).toEqual({});
  });

  it('a proper skill folder, a folder with no SKILL.md, a README and other files are not reported', async () => {
    write(path.join(cwd(), '.claude', 'skills', 'good', 'SKILL.md'), '---' + String.fromCharCode(10) + 'name: good' + String.fromCharCode(10) + '---');
    // the owner's own ~/.claude/skills/synced is exactly this: a folder the CLI keeps
    write(path.join(userDir(), 'skills', 'synced', 'abc_def', 'data.json'), '{}');
    write(path.join(cwd(), '.claude', 'skills', 'README.md'), 'what lives here');
    write(path.join(cwd(), '.claude', 'skills', 'notes.txt'), 'not markdown');
    expect(await findMisplacedSkills(roots())).toEqual([]);
  });

  it('no skills folder anywhere: an empty answer and no log line', async () => {
    const log = vi.fn();
    expect(await findMisplacedSkills(roots(), log)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('Claude declares it through the commandFiles capability', () => {
    expect(typeof claudeCommandFiles.misplaced).toBe('function');
  });
});
