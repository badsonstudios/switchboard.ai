// The ACP wire's pure readers (E40 item 06, #1289).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { classify, permissionOutcome, readConfigOptions, readMcpServers, stdioMcpServer } from './acp-protocol';
import { categoryOfKind, toolResult } from './acp-events';
import { fakeAcpCliPath } from './fake-acp';

describe('permissionOutcome chooses by KIND and answers by optionId', () => {
  const codex = [
    { optionId: 'allow_once', kind: 'allow_once' },
    { optionId: 'accept_execpolicy_amendment', kind: 'allow_always' },
    { optionId: 'cancel', kind: 'reject_once' },
  ];
  it('allow is allow_once, never allow_always', () => {
    expect(permissionOutcome(codex, 'allow')).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
    expect(permissionOutcome([{ optionId: 'a', kind: 'allow_always' }], 'allow')).toBeNull();
  });
  it('deny is reject_once, else reject_always, else the cancelled outcome', () => {
    expect(permissionOutcome(codex, 'deny')).toEqual({
      outcome: { outcome: 'selected', optionId: 'cancel' },
    });
    expect(permissionOutcome([{ optionId: 'never', kind: 'reject_always' }], 'deny')).toEqual({
      outcome: { outcome: 'selected', optionId: 'never' },
    });
    expect(permissionOutcome([], 'deny')).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });
});

describe('classify', () => {
  it('keeps id 0, tolerates a missing "jsonrpc", and calls the rest malformed', () => {
    expect(classify({ id: 0, method: 'session/request_permission', params: {} })).toMatchObject({
      kind: 'request',
      id: 0,
    });
    expect(classify({ id: 3, result: { a: 1 } })).toEqual({
      kind: 'response',
      id: 3,
      result: { a: 1 },
    });
    expect(
      classify({
        id: 3,
        error: { code: -32000, message: 'Authentication required' },
      })
    ).toEqual({
      kind: 'error',
      id: 3,
      code: -32000,
      message: 'Authentication required',
    });
    expect(classify({ method: 'session/update' })).toEqual({
      kind: 'notification',
      method: 'session/update',
      params: {},
    });
    expect(classify([1, 2])).toEqual({ kind: 'malformed' });
    expect(classify('text')).toEqual({ kind: 'malformed' });
    expect(classify({ id: 1 })).toEqual({ kind: 'malformed' });
  });
});

describe('config options', () => {
  it('reads select options, flattens groups, drops what it cannot read', () => {
    expect(
      readConfigOptions([
        {
          id: 'model',
          category: 'model',
          type: 'select',
          currentValue: 'a',
          options: [
            {
              group: 'g',
              name: 'G',
              options: [{ value: 'a', name: 'A' }, { value: 'b' }],
            },
          ],
        },
        { id: 'fast', type: 'boolean', currentValue: true },
        { id: 'bad' },
      ])
    ).toEqual([
      {
        id: 'model',
        category: 'model',
        currentValue: 'a',
        choices: [{ value: 'a', name: 'A' }, { value: 'b' }],
      },
    ]);
    expect(readConfigOptions(undefined)).toBeNull();
  });
});

describe('the bus server entry', () => {
  it('is a stdio server with env as a list, and reads back out', () => {
    const server = stdioMcpServer('switchboard', {
      command: 'C:/e.exe',
      args: ['b.js'],
      env: { A: '1' },
    });
    expect(server).toEqual({
      name: 'switchboard',
      command: 'C:/e.exe',
      args: ['b.js'],
      env: [{ name: 'A', value: '1' }],
    });
    expect(readMcpServers({ mcpServers: [server, { name: 'broken' }] })).toEqual([server]);
    expect(readMcpServers(undefined)).toEqual([]);
  });
});

describe('tool results', () => {
  it('a shell result is its exit code; an MCP one its text; a failure is marked', () => {
    expect(
      toolResult(
        {
          toolCallId: 't',
          status: 'completed',
          _meta: { terminal_exit: { exit_code: 2 } },
        },
        100
      )
    ).toEqual({
      t: 'tool-result',
      toolUseId: 't',
      out: 'Exit code 2',
    });
    expect(
      toolResult(
        {
          toolCallId: 't',
          status: 'completed',
          rawOutput: {
            result: { content: [{ type: 'text', text: 'stub-echo:hi' }] },
          },
        },
        100
      )
    ).toMatchObject({ out: 'stub-echo:hi' });
    expect(toolResult({ toolCallId: 't', status: 'failed' }, 100)).toMatchObject({ failed: true });
    expect(toolResult({ toolCallId: 't', status: 'in_progress' }, 100)).toBeNull();
  });
  it('maps kinds onto the Feed categories', () => {
    expect(['execute', 'edit', 'delete', 'read', 'fetch', 'think', undefined].map(categoryOfKind)).toEqual([
      'shell',
      'edit',
      'edit',
      'read',
      'read',
      'other',
      'other',
    ]);
  });
});

describe('fakeAcpCliPath', () => {
  it('finds the compiled agent beside it or one directory up, else names what is missing', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fakeacp-'));
    try {
      const chunks = path.join(base, 'chunks');
      fs.mkdirSync(chunks);
      expect(() => fakeAcpCliPath(chunks)).toThrow(/fake-acp-cli\.js not found/);
      fs.writeFileSync(path.join(base, 'fake-acp-cli.js'), '');
      expect(fakeAcpCliPath(chunks)).toBe(path.join(base, 'fake-acp-cli.js'));
      expect(fakeAcpCliPath(base)).toBe(path.join(base, 'fake-acp-cli.js'));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
