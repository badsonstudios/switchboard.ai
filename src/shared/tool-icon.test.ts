// Which picture goes beside a tool's name (#757). Every kind is reachable, the
// names that share a kind share it on purpose, and nothing is ever left with no
// picture.
import { describe, it, expect } from 'vitest';
import { commandIconFor, gutterIconFor, TOOL_ICONS, toolIconFor } from './tool-icon';
import { READ_TOOLS, SHELLISH } from './tool-taxonomy';

describe('toolIconFor', () => {
  it('the four the owner named: agent, question, read, shell', () => {
    expect(toolIconFor('Task')).toBe('agent');
    expect(toolIconFor('Agent')).toBe('agent');
    expect(toolIconFor('AskUserQuestion')).toBe('question');
    expect(toolIconFor('Read')).toBe('read');
    expect(toolIconFor('Bash')).toBe('shell');
  });

  it('ONE icon for the shell, whichever shell it is', () => {
    for (const name of SHELLISH) expect(toolIconFor(name)).toBe('shell');
    expect(toolIconFor('PowerShell')).toBe('shell');
  });

  it('watching or stopping a background command is a shell step too', () => {
    for (const name of ['BashOutput', 'KillShell', 'Monitor', 'TaskOutput', 'TaskStop']) {
      expect(toolIconFor(name)).toBe('shell');
    }
  });

  it('the checklist under its newer per-task names', () => {
    for (const name of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']) {
      expect(toolIconFor(name)).toBe('todos');
    }
    // and `Task` on its own is still the agent, not a checklist item
    expect(toolIconFor('Task')).toBe('agent');
  });

  it('the rest of the map: edit, search, todos, web', () => {
    for (const name of ['Edit', 'MultiEdit']) expect(toolIconFor(name)).toBe('edit');
    // #1207: a whole new file is not a change to one, and a notebook is its own thing
    expect(toolIconFor('Write')).toBe('write');
    expect(toolIconFor('NotebookEdit')).toBe('notebook');
    expect(toolIconFor('NotebookRead')).toBe('notebook');
    for (const name of ['Glob', 'Grep', 'LS']) expect(toolIconFor(name)).toBe('search');
    expect(toolIconFor('TodoWrite')).toBe('todos');
    expect(toolIconFor('WebFetch')).toBe('web');
    expect(toolIconFor('WebSearch')).toBe('web');
  });

  it('searching is told apart from reading, although both are read-only tools', () => {
    // `READ_TOOLS` is the permission gate's list; three of its four are searches
    expect(READ_TOOLS.map(toolIconFor).sort()).toEqual(['read', 'search', 'search', 'search']);
  });

  it('any MCP tool gets the plugged-in mark, whatever server it came from', () => {
    expect(toolIconFor('mcp__switchboard__list_sessions')).toBe('mcp');
    expect(toolIconFor('mcp__github__create_issue')).toBe('mcp');
    // the prefix, not the letters: a tool merely named like one is not one
    expect(toolIconFor('mcp')).toBe('other');
  });

  it('⚠️ an unknown tool gets the fallback, NEVER nothing', () => {
    for (const name of ['SomeToolFromNextYear', 'ExitPlanMode', 'Skill', '', undefined, null]) {
      expect(toolIconFor(name)).toBe('other');
    }
  });

  it('a name is matched exactly: case and near-misses are unknown, not guessed', () => {
    expect(toolIconFor('bash')).toBe('other');
    expect(toolIconFor('Reader')).toBe('other');
  });

  it('every kind in the list is one some tool can actually get', () => {
    const names = [
      'Task', 'AskUserQuestion', 'Read', 'Grep', 'Bash', 'Edit', 'TodoWrite', 'WebFetch',
      'mcp__x__y', 'Unknown', 'Write', 'NotebookEdit',
    ];
    // by name, plus the ones only a command line or a fold can be (#1207)
    const reachable = new Set<string>([
      ...names.map(toolIconFor),
      'explore',
      ...['git status', 'npm test', 'python x.py', 'pwsh -c ls', 'docker ps'].map(
        (c) => commandIconFor(c)!
      ),
    ]);
    expect(reachable).toEqual(new Set(TOOL_ICONS));
  });
});

// #1207 — the picture is in the timeline gutter, and a command says what it runs.
describe('commandIconFor — the first word of a command (#1207)', () => {
  it.each([
    ['git status', 'git'],
    ['gh pr view 12', 'git'],
    ['npm test', 'node'],
    ['npx vitest run', 'node'],
    ['node scripts/build.js', 'node'],
    ['python x.py', 'python'],
    ['py -m pytest', 'python'],
    ['pip install requests', 'python'],
    ['powershell -File build.ps1', 'powershell'],
    ['pwsh -c Get-ChildItem', 'powershell'],
    ['docker compose up', 'container'],
  ])('%j is %s', (command, kind) => {
    expect(commandIconFor(command)).toBe(kind);
  });

  it('skips the environment a command is given, and reads what it runs', () => {
    expect(commandIconFor('CI=1 NODE_ENV=test npm test')).toBe('node');
    expect(commandIconFor('  FOO=bar   git   log')).toBe('git');
  });

  it('reads a program by its name, not its path or its .exe', () => {
    expect(commandIconFor('C:\\tools\\git.exe status')).toBe('git');
    expect(commandIconFor('/usr/bin/python3 run.py')).toBe('python');
    expect(commandIconFor('"C:/Program Files/nodejs/node.exe" x.js')).toBe(null);
    expect(commandIconFor('NPM run build')).toBe('node');
  });

  it('a script it is handed, when the program says nothing', () => {
    expect(commandIconFor('./deploy.ps1 -Fast')).toBe('powershell');
    expect(commandIconFor('scripts/seed.py --all')).toBe('python');
    expect(commandIconFor('./tools/check.mjs')).toBe('node');
  });

  it('a chain is whatever its FIRST command is: data, not a parser', () => {
    expect(commandIconFor('git add -A && npm test')).toBe('git');
  });

  it('looks past ONE prefix, `cd <dir> &&`, because that is how most commands are written', () => {
    expect(commandIconFor('cd src && git status')).toBe('git');
    expect(commandIconFor('cd packages/app && npm test')).toBe('node');
    expect(commandIconFor('cd "C:/Projects/x" && python run.py')).toBe('python');
    // ...and only that shape: nothing else is skipped
    expect(commandIconFor('cd a b && git status')).toBeNull();
    expect(commandIconFor('cd src; git status')).toBeNull();
    expect(commandIconFor('sudo git status')).toBeNull();
    expect(commandIconFor('time npm test')).toBeNull();
    expect(commandIconFor('cd src && cd lib && git status')).toBeNull();
  });

  it('a Windows wrapper is the program it wraps', () => {
    expect(commandIconFor('npm.cmd run build')).toBe('node');
    expect(commandIconFor('npx.cmd vitest')).toBe('node');
    expect(commandIconFor('git.bat status')).toBe('git');
  });

  it('anything else is not recognised, and says so with null', () => {
    for (const c of ['ls -la', 'echo hi', 'make build', './run.sh', '', '   ', 'FOO=bar']) {
      expect(commandIconFor(c), c).toBeNull();
    }
    expect(commandIconFor(undefined)).toBeNull();
    expect(commandIconFor(null)).toBeNull();
    // a name the table has only as an inherited property is not a program
    expect(commandIconFor('toString')).toBeNull();
    expect(commandIconFor('constructor --help')).toBeNull();
  });
});

describe('gutterIconFor — what a block wears in the gutter (#1207)', () => {
  const tool = (name: string, more: Record<string, unknown> = {}) => ({
    kind: 'tool',
    tool: { name, ...more },
  });

  it('a tool block wears its kind', () => {
    expect(gutterIconFor(tool('Read'))).toBe('read');
    expect(gutterIconFor(tool('Grep'))).toBe('search');
    expect(gutterIconFor(tool('Edit'))).toBe('edit');
    expect(gutterIconFor(tool('Write'))).toBe('write');
    expect(gutterIconFor(tool('NotebookEdit'))).toBe('notebook');
    expect(gutterIconFor(tool('Task'))).toBe('agent');
    expect(gutterIconFor(tool('AskUserQuestion'))).toBe('question');
    expect(gutterIconFor(tool('WebSearch'))).toBe('web');
    expect(gutterIconFor(tool('mcp__github__create_issue'))).toBe('mcp');
  });

  it('the checklist is a block with no tool on it, and still has one', () => {
    expect(gutterIconFor({ kind: 'todos' })).toBe('todos');
  });

  it('a command wears what it RUNS, and the terminal when that is not known', () => {
    expect(gutterIconFor(tool('Bash', { summary: 'git status' }))).toBe('git');
    expect(gutterIconFor(tool('Bash', { summary: 'python x.py' }))).toBe('python');
    expect(gutterIconFor(tool('Bash', { summary: 'ls -la' }))).toBe('shell');
    expect(gutterIconFor(tool('Bash', {}))).toBe('shell');
  });

  it('the PowerShell tool is PowerShell, unless its command says something more', () => {
    expect(gutterIconFor(tool('PowerShell', { summary: 'Get-ChildItem' }))).toBe('powershell');
    expect(gutterIconFor(tool('PowerShell', { summary: 'git status' }))).toBe('git');
  });

  it('watching a background command is a shell step, and its subject is not a command', () => {
    // `BashOutput`'s summary is a task id; it must not be read as a program
    expect(gutterIconFor(tool('BashOutput', { summary: 'git' }))).toBe('shell');
  });

  it('⚠️ an unrecognised tool keeps the plain dot: null, never a placeholder', () => {
    expect(gutterIconFor(tool('SomeToolFromNextYear'))).toBeNull();
    expect(gutterIconFor({ kind: 'tool' })).toBeNull();
  });

  it('prose, a prompt, thinking and a notice are not tool blocks', () => {
    for (const kind of ['assistant', 'user', 'thinking', 'notice']) {
      expect(gutterIconFor({ kind })).toBeNull();
    }
  });
});
