// Which picture goes beside a tool's name (#757). Every kind is reachable, the
// names that share a kind share it on purpose, and nothing is ever left with no
// picture.
import { describe, it, expect } from 'vitest';
import { TOOL_ICONS, toolIconFor } from './tool-icon';
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
    for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(toolIconFor(name)).toBe('edit');
    }
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
      'mcp__x__y', 'Unknown',
    ];
    expect(new Set(names.map(toolIconFor))).toEqual(new Set(TOOL_ICONS));
  });
});
