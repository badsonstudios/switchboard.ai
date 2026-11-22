// @vitest-environment jsdom
// The finish dialogs (#1638, mockup screen D): Remove asks once and keeps an
// unmerged branch by default; the PR dialog shows an open PR instead of making
// a second, and says when gh is missing; an update stopped on conflicts lists
// the files and offers the session, abort, or "I'll do it myself".
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { PullRequestDialog, RemoveWorktreeDialog, UpdateStoppedDialog } from './FinishWorktreeDialogs';
import type { PullRequestContext, RemoveCheck } from '../../../shared/projects';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;

async function render(el: React.JSX.Element): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(el);
  });
  // let the dialog's load resolve
  await act(async () => {
    await Promise.resolve();
  });
}

const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
const click = async (el: Element | null): Promise<void> => {
  await act(async () => {
    (el as HTMLElement).click();
  });
};

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

const check = (over: Partial<RemoveCheck> = {}): RemoveCheck => ({
  path: '/wt/fix',
  branch: 'fix/1634',
  dirty: [],
  unmerged: 0,
  mergedPr: false,
  links: [],
  base: 'main',
  ...over,
});

describe('RemoveWorktreeDialog', () => {
  it('lists uncommitted files and unmerged commits, keeps the branch by default, and says "Remove anyway"', async () => {
    const sent: Array<{ force: boolean; keepBranch: boolean }> = [];
    await render(
      <RemoveWorktreeDialog
        branch="fix/1634"
        load={() => Promise.resolve(check({ dirty: ['a.ts', 'en.json'], unmerged: 2, links: ['node_modules'] }))}
        sessions={['Queue fix']}
        onConfirm={(o) => sent.push(o)}
        onCancel={() => {}}
      />
    );
    expect(q('[data-remove-worktree-dirty]')?.textContent).toContain('a.ts, en.json');
    expect(q('[data-remove-worktree-unmerged]')?.textContent).toContain('2 commits');
    expect(q<HTMLInputElement>('[data-remove-worktree-keep]')?.checked).toBe(true);
    expect(q('[data-remove-worktree-sessions]')?.textContent).toContain('Queue fix');
    expect(document.body.textContent).toContain('node_modules');
    const go = q('[data-remove-worktree-confirm]');
    expect(go?.textContent).toBe('Remove anyway');
    await click(go);
    expect(sent).toEqual([{ force: true, keepBranch: true }]);
  });

  it('a merged branch defaults to deleting it; a clean worktree just says "Remove"', async () => {
    const sent: Array<{ force: boolean; keepBranch: boolean }> = [];
    await render(
      <RemoveWorktreeDialog
        branch="fix/1634"
        load={() => Promise.resolve(check({ unmerged: 3, mergedPr: true }))}
        sessions={[]}
        onConfirm={(o) => sent.push(o)}
        onCancel={() => {}}
      />
    );
    expect(q<HTMLInputElement>('[data-remove-worktree-keep]')?.checked).toBe(false);
    expect(q('[data-remove-worktree-unmerged]')).toBeNull();
    const go = q('[data-remove-worktree-confirm]');
    expect(go?.textContent).toBe('Remove');
    await click(go);
    expect(sent).toEqual([{ force: false, keepBranch: false }]);
  });
});

const ctx = (over: Partial<PullRequestContext> = {}): PullRequestContext => ({
  branch: 'feat/x',
  base: 'main',
  existing: null,
  hasRemote: true,
  gh: null,
  ...over,
});

describe('PullRequestDialog', () => {
  it('sends the edited title, the body and the draft choice', async () => {
    const sent: Array<{ title: string; body: string; draft: boolean }> = [];
    await render(
      <PullRequestDialog
        load={() => Promise.resolve(ctx())}
        initialTitle="Fix it"
        initialBody={'Sessions:\n\n- A'}
        onSubmit={(r) => {
          sent.push(r);
          return Promise.resolve(null);
        }}
        onOpenUrl={() => {}}
        onClose={() => {}}
      />
    );
    expect(q<HTMLInputElement>('[data-pr-title]')?.value).toBe('Fix it');
    await click(q('[data-pr-draft]'));
    await click(q('[data-pr-submit]'));
    expect(sent).toEqual([{ title: 'Fix it', body: 'Sessions:\n\n- A', draft: true }]);
  });

  it('an open PR is offered to open, never a second one', async () => {
    const opened: string[] = [];
    await render(
      <PullRequestDialog
        load={() => Promise.resolve(ctx({ existing: { number: 4, url: 'https://github.com/o/r/pull/4', state: 'OPEN', draft: false } }))}
        initialTitle="T"
        initialBody=""
        onSubmit={() => Promise.resolve(null)}
        onOpenUrl={(u) => opened.push(u)}
        onClose={() => {}}
      />
    );
    expect(q('[data-pr-existing]')?.textContent).toContain('#4');
    expect(q('[data-pr-submit]')).toBeNull();
    await click(q('[data-pr-open-existing]'));
    expect(opened).toEqual(['https://github.com/o/r/pull/4']);
  });

  it('says plainly when gh is not installed, with nothing to press', async () => {
    await render(
      <PullRequestDialog
        load={() => Promise.resolve(ctx({ gh: 'gh-missing' }))}
        initialTitle="T"
        initialBody=""
        onSubmit={() => Promise.resolve(null)}
        onOpenUrl={() => {}}
        onClose={() => {}}
      />
    );
    expect(q('[data-pr-blocked]')?.textContent).toContain('cli.github.com');
    expect(q<HTMLButtonElement>('[data-pr-submit]')?.disabled).toBe(true);
  });
});

describe('UpdateStoppedDialog', () => {
  it('lists the conflicted files and offers the session, abort, or doing it yourself', async () => {
    const did: string[] = [];
    await render(
      <UpdateStoppedDialog
        branch="feat/x"
        outcome={{ kind: 'conflicts', base: 'origin/main', files: ['CHANGELOG.md', 'src/a.ts'] }}
        sessionName="Queue fix"
        onAskSession={() => did.push('ask')}
        onAbort={() => did.push('abort')}
        onClose={() => did.push('close')}
      />
    );
    expect([...document.querySelectorAll('[data-update-files] li')].map((l) => l.textContent)).toEqual([
      'CHANGELOG.md',
      'src/a.ts',
    ]);
    expect(q('[data-update-words]')?.textContent).toContain('left mid-merge');
    expect(q('[data-update-ask-session]')?.textContent).toBe('Ask Queue fix to resolve');
    await click(q('[data-update-ask-session]'));
    await click(q('[data-update-abort]'));
    await click(q('[data-update-myself]'));
    expect(did).toEqual(['ask', 'abort', 'close']);
  });

  it('a refusal for uncommitted work names the files and offers no abort', async () => {
    await render(
      <UpdateStoppedDialog
        branch="feat/x"
        outcome={{ kind: 'refused', code: 'dirty', files: ['a.txt'] }}
        sessionName={null}
        onAskSession={() => {}}
        onAbort={() => {}}
        onClose={() => {}}
      />
    );
    expect(q('[data-update-words]')?.textContent).toContain('Nothing was changed');
    expect(q('[data-update-files]')?.textContent).toBe('a.txt');
    expect(q('[data-update-abort]')).toBeNull();
  });
});
