import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SlashCommand } from '../../shared/slash-commands';
import { scanSlashCommands } from './slash-commands';

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-slash-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

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

  it('YAML block-scalar descriptions read as NO description, not a "|" glyph', async () => {
    write(
      path.join(cwd(), '.claude', 'skills', 'blocky', 'SKILL.md'),
      '---\nname: blocky\ndescription: >-\n  a folded multi-line\n  description\n---\n'
    );
    expect((await scanByName())['blocky']).toMatchObject({ name: 'blocky', description: undefined });
  });
});
