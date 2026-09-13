// @vitest-environment jsdom
// The card header's git line, and the answer it must NOT invent (#785).
//
// #785 gave `GitService.status` a third state: `unreadable`, carried alongside
// `isRepo: true` whenever `rev-parse` had already confirmed a work tree and
// something later failed. That shape — a repo, no branch, no files — is
// indistinguishable from a clean checkout to anything that only reads `isRepo`,
// and this component only read `isRepo`. Left alone it would have started
// drawing `⎇ ?` with a silent zero dirty-count for a repository nobody could
// read: a confident wrong answer INVENTED BY THE FIX, on the surface the user
// glances at rather than the one they opened on purpose.
//
// The reason goes to the Changes tab, which is where the question was asked.
// Here, silence.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { GitContext } from './GitContext';
import type { GitStatusDto } from '../lib/git-status';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const status = (over: Partial<GitStatusDto> = {}): GitStatusDto => ({
  isRepo: true,
  branch: 'main',
  files: [],
  ...over,
});

async function render(s: GitStatusDto | null): Promise<void> {
  await act(async () => {
    root!.render(<GitContext status={s} />);
  });
}

describe('the card-header git line', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await initI18nForTests();
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
  });

  it('shows the branch, and the dirty count when there is one', async () => {
    // The control. Without it every assertion below is satisfied by a component
    // that renders nothing under any circumstances.
    await render(status({ files: [{ path: 'a.ts', staged: false, unstaged: true, untracked: false }] }));
    expect(host.textContent).toContain('main');
    expect(host.textContent).toContain('1');
  });

  it('draws nothing for a folder that is not a repository', async () => {
    await render(status({ isRepo: false, branch: undefined }));
    expect(host.textContent).toBe('');
  });

  it('⚠️ DRAWS NOTHING for a repository it could not read — no branch, no zero', async () => {
    // The shape `status()` really produces on the guard and status branches.
    // `isRepo` alone says "yes, a repository" and the old test would have
    // passed it straight through to `⎇ ?`.
    await render(status({ branch: undefined, unreadable: 'git could not be started' }));
    expect(host.textContent).toBe('');
  });

  it('…including when the probe never got an answer at all', async () => {
    await render(status({ isRepo: false, branch: undefined, unreadable: 'that folder no longer exists' }));
    expect(host.textContent).toBe('');
  });

  it('draws nothing before any answer has landed', async () => {
    await render(null);
    expect(host.textContent).toBe('');
  });
});
