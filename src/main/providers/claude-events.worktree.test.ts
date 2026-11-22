// The agent's own worktree moves, read off the stream (#1616). The first two
// suites replay the frames MEASURED against CLI 2.1.322
// (`spike/probes/1616/`, `spike/findings/1616-enter-worktree.md`).
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { claudeEvents, translateClaudeFrame, worktreeMoves } from './claude-events';
import type { EngineEvent } from '../sessions/engine-events';

const probe = (name: string): Record<string, unknown>[] =>
  fs
    .readFileSync(path.join(__dirname, '../../../spike/probes/1616', name), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const moves = (evs: EngineEvent[]) => evs.filter((e) => e.type === 'workdir');

function run(frames: Record<string, unknown>[]): EngineEvent[] {
  const translate = claudeEvents.createTranslator({});
  return frames.flatMap((f) => translate(f));
}

const call = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
  parent_tool_use_id: null,
  ...extra,
});
const result = (id: string, toolUseResult: unknown, extra: Record<string, unknown> = {}, block: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', ...block }] },
  parent_tool_use_id: null,
  tool_use_result: toolUseResult,
  ...extra,
});

describe('measured frames (CLI 2.1.322)', () => {
  it('EnterWorktree moves the session into the worktree, with its branch', () => {
    expect(moves(run(probe('enter.jsonl')))).toEqual([
      { type: 'workdir', move: 'reported', cwd: 'C:\\tmp\\p1616\\repo' },
      {
        type: 'workdir',
        move: 'entered',
        cwd: 'C:\\tmp\\p1616\\repo\\.claude\\worktrees\\probe',
        branch: 'worktree-probe',
      },
    ]);
  });

  it('a resumed session reports the worktree it was put back in, and ExitWorktree brings it home', () => {
    expect(moves(run(probe('exit.jsonl')))).toEqual([
      { type: 'workdir', move: 'reported', cwd: 'C:\\tmp\\p1616\\repo\\.claude\\worktrees\\probe' },
      { type: 'workdir', move: 'left', cwd: 'C:\\tmp\\p1616\\repo' },
    ]);
  });
});

describe('what moves nothing (P6)', () => {
  const enter = { worktreePath: '/r/.claude/worktrees/a', worktreeBranch: 'worktree-a', message: 'm' };

  it('a failed call', () => {
    const skipped: string[] = [];
    const t = worktreeMoves((msg) => skipped.push(msg));
    t(call('t1', 'EnterWorktree'));
    expect(t(result('t1', enter, {}, { is_error: true }))).toEqual([]);
    expect(skipped).toHaveLength(1);
  });

  it('a result in a shape we do not know', () => {
    const skipped: string[] = [];
    const t = worktreeMoves((msg) => skipped.push(msg));
    t(call('t1', 'EnterWorktree'));
    expect(t(result('t1', { path: 3 }))).toEqual([]);
    t(call('t2', 'ExitWorktree'));
    expect(t(result('t2', 'not an object'))).toEqual([]);
    expect(skipped).toHaveLength(2);
  });

  it('the Agent tool, whose result carries the same worktreePath field', () => {
    const t = worktreeMoves();
    t(call('a1', 'Agent'));
    expect(t(result('a1', { status: 'completed', prompt: 'p', ...enter }))).toEqual([]);
  });

  it('a result with no call we saw', () => {
    expect(worktreeMoves()(result('nobody', enter))).toEqual([]);
  });

  it("a subagent's own worktree", () => {
    const t = worktreeMoves();
    t(call('s1', 'EnterWorktree', { parent_tool_use_id: 'p' }));
    expect(t(result('s1', enter))).toEqual([]);
    t(call('s2', 'EnterWorktree'));
    expect(t(result('s2', enter, { parent_tool_use_id: 'p' }))).toEqual([]);
  });

  it('a call is read once: a repeated result moves nothing twice', () => {
    const t = worktreeMoves();
    t(call('t1', 'EnterWorktree'));
    expect(t(result('t1', enter))).toHaveLength(1);
    expect(t(result('t1', enter))).toEqual([]);
  });

  it('keeps at most a handful of unanswered calls', () => {
    const t = worktreeMoves();
    for (let i = 0; i < 40; i++) t(call(`c${i}`, 'EnterWorktree'));
    expect(t(result('c0', enter))).toEqual([]); // long forgotten
    expect(t(result('c39', enter))).toHaveLength(1);
  });
});

describe('ExitWorktree', () => {
  it('prefers where the CLI really put the session over where it started', () => {
    const t = worktreeMoves();
    t(call('x', 'ExitWorktree'));
    expect(
      t(result('x', { action: 'remove', originalCwd: '/gone', worktreePath: '/w', restoredCwd: '/home/u', message: 'm' }))
    ).toEqual([{ type: 'workdir', move: 'left', cwd: '/home/u' }]);
  });
});

describe('system:init', () => {
  it('restates the cwd beside the conversation, and nothing when it has none', () => {
    expect(translateClaudeFrame({ type: 'system', subtype: 'init', session_id: 'c', cwd: '/p' })).toContainEqual({
      type: 'workdir',
      move: 'reported',
      cwd: '/p',
    });
    expect(
      (translateClaudeFrame({ type: 'system', subtype: 'init', session_id: 'c', cwd: '' }) ?? []).some(
        (e) => e.type === 'workdir'
      )
    ).toBe(false);
  });
});
