// @vitest-environment jsdom
// The new-worktree dialog (#1506, screen C): the branch follows "what's it
// for" until edited, an existing branch is checked out as it is (no base), a
// branch already checked out elsewhere cannot be picked, and Create sends one
// request with the project's setup only when it is ticked.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { NewWorktreeDialog, branchProblem } from './NewWorktreeDialog';
import type { RailProject } from '../model/types';
import type { NewWorktreeRequest } from '../../../shared/projects';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const project = (over: Partial<RailProject> = {}): RailProject => ({
  id: 'p1',
  name: 'App',
  color: '#5e9fe6',
  commonDir: '/r/.git',
  primaryPath: '/r',
  hiddenWorktrees: [],
  worktrees: [
    { path: '/r', primary: true, branch: 'main', head: 'a', detached: false },
    { path: '/wt/busy', primary: false, branch: 'busy', head: 'b', detached: false },
  ],
  setupCommand: 'npm ci',
  ...over,
});

async function mount(p: RailProject, sent: NewWorktreeRequest[]): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <NewWorktreeDialog
        project={p}
        loadBranches={() => Promise.resolve({ local: ['main', 'busy', 'old'], remote: ['origin/main'], defaultBase: 'origin/main' })}
        onCreate={(r) => sent.push(r)}
        onCancel={() => {}}
      />
    );
  });
}

const q = <T extends Element>(sel: string): T => document.querySelector<T>(sel)!;

/** React's own value setter, so its onChange fires */
async function type(el: HTMLInputElement, value: string): Promise<void> {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

describe('NewWorktreeDialog', () => {
  it('suggests the branch from what it is for, starts from the default base, and sends one request', async () => {
    const sent: NewWorktreeRequest[] = [];
    await mount(project(), sent);
    await type(q('[data-new-worktree-purpose]'), 'MCP keys: off the command line');
    expect(q<HTMLInputElement>('[data-new-worktree-branch]').value).toBe('mcp-keys-off-the-command-line');
    expect(q<HTMLInputElement>('[data-new-worktree-base]').value).toBe('origin/main');
    await act(async () => q<HTMLButtonElement>('[data-new-worktree-ok]').click());
    expect(sent).toEqual([
      {
        projectId: 'p1',
        branch: 'mcp-keys-off-the-command-line',
        newBranch: true,
        base: 'origin/main',
        title: 'MCP keys: off the command line',
        runSetup: true,
      },
    ]);
  });

  it('checks out an existing branch as it is, and can skip setup', async () => {
    const sent: NewWorktreeRequest[] = [];
    await mount(project(), sent);
    await type(q('[data-new-worktree-branch]'), 'old');
    expect(q<HTMLInputElement>('[data-new-worktree-base]').disabled).toBe(true);
    await act(async () => q<HTMLInputElement>('[data-new-worktree-setup]').click());
    await act(async () => q<HTMLButtonElement>('[data-new-worktree-ok]').click());
    expect(sent[0]).toMatchObject({ branch: 'old', newBranch: false, runSetup: false });
    expect(sent[0].base).toBeUndefined();
  });

  it('will not offer a branch another worktree has checked out', async () => {
    const sent: NewWorktreeRequest[] = [];
    await mount(project(), sent);
    await type(q('[data-new-worktree-branch]'), 'busy');
    expect(q<HTMLButtonElement>('[data-new-worktree-ok]').disabled).toBe(true);
    expect(q('[data-new-worktree-status]').textContent).toContain('already checked out');
  });

  it('has no setup box when the project has no setup command', async () => {
    await mount(project({ setupCommand: undefined }), []);
    expect(document.querySelector('[data-new-worktree-setup]')).toBeNull();
  });
});

describe('branchProblem', () => {
  it('keeps the rules main keeps', () => {
    expect(branchProblem('feat/x')).toBeNull();
    expect(branchProblem('')).toBe('empty');
    expect(branchProblem('-x')).toBe('chars');
    expect(branchProblem('a..b')).toBe('chars');
    expect(branchProblem('a b')).toBe('chars');
    expect(branchProblem('a.lock')).toBe('chars');
  });
});
