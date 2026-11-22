// @vitest-environment jsdom
// The agent moved into a worktree (#1616): the Feed's one quiet line, and the
// card's "in <worktree>" beside its branch.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { feedBlockRenderers } from './feed-blocks';
import type { FeedBlockDto } from '../lib/feed';
import { blockVisible } from '../lib/feed';
import { GitContext } from '../components/GitContext';
import type { GitStatusDto } from '../lib/git-status';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const WT = 'C:\\repo\\.claude\\worktrees\\probe';
let root: Root;
let host: HTMLElement;

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const block = (to: 'worktree' | 'folder', folder: string): FeedBlockDto =>
  ({ seq: 1, kind: 'moved', moved: { to, folder }, sidechain: false });

function renderBlock(b: FeedBlockDto): void {
  const r = feedBlockRenderers.filter((x) => x.matches(b)).sort((a, z) => a.order - z.order)[0];
  act(() => root.render(<>{r.render(b)}</>));
}

describe('the moved line', () => {
  it('names the worktree and its whole path', () => {
    renderBlock(block('worktree', WT));
    const line = host.querySelector('[data-moved-line]')!;
    expect(line.getAttribute('data-moved-to')).toBe('worktree');
    expect(line.textContent).toBe(`Moved to worktree probe (${WT})`);
  });

  it('and the way back', () => {
    renderBlock(block('folder', 'C:\\repo'));
    expect(host.querySelector('[data-moved-line]')!.textContent).toBe('Back in repo (C:\\repo)');
  });

  it('is an event: shown at normal, not in the prose-only view', () => {
    expect(blockVisible(block('worktree', WT), 'normal')).toBe(true);
    expect(blockVisible(block('worktree', WT), 'quiet')).toBe(false);
  });
});

describe('the card says where it works', () => {
  const status = { isRepo: true, branch: 'worktree-probe', files: [] } as unknown as GitStatusDto;

  it('shows the worktree before the branch when the agent moved', () => {
    act(() => root.render(<GitContext status={status} worktree={WT} />));
    const chip = host.querySelector('[data-testid="card-worktree"]')!;
    expect(chip.textContent).toBe('in probe');
    expect(chip.getAttribute('title')).toContain(WT);
  });

  it('and nothing extra when it did not', () => {
    act(() => root.render(<GitContext status={status} />));
    expect(host.querySelector('[data-testid="card-worktree"]')).toBeNull();
  });
});
