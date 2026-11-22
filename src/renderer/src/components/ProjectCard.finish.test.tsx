// @vitest-environment jsdom
// The worktree ⋯ menu's finishing half (#1638, mockup screen D) and the
// numbers beside a worktree: "Update from main" with the behind count, Push &
// open pull request… while the repo has a remote, Merge into main locally only
// when it has none, and Remove worktree… never on the primary checkout.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { ProjectCard } from './ProjectCard';
import type { RailProject, RailSession } from '../model/types';
import type { ProjectWorktreeRows } from '../lib/groups';
import type { ProjectStats } from '../../../shared/projects';
import { GROUP_PALETTE } from '../../../shared/group-palette';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;

const project: RailProject = {
  id: 'p1',
  name: 'App',
  color: GROUP_PALETTE[0],
  commonDir: '/r/.git',
  primaryPath: '/r',
  hiddenWorktrees: [],
  worktrees: [
    { path: '/r', primary: true, branch: 'main', head: 'a', detached: false },
    { path: '/wt/fix', primary: false, branch: 'fix/1634', head: 'b', detached: false },
  ],
};

const sections: Array<ProjectWorktreeRows<RailSession>> = project.worktrees!.map((w) => ({
  path: w.path,
  bucket: `wt:${w.path}`,
  info: w,
  members: [],
}));

const stats = (hasRemote: boolean): ProjectStats => ({
  projectId: 'p1',
  hasRemote,
  base: 'origin/main',
  worktrees: [
    { path: '/r', base: 'origin/main', ahead: 0, behind: 0, added: 0, removed: 0 },
    { path: '/wt/fix', base: 'origin/main', ahead: 2, behind: 3, added: 120, removed: 8 },
  ],
});

async function mount(s: ProjectStats, calls: string[]): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ProjectCard
        project={project}
        sections={sections}
        renderRows={() => []}
        collapsed={false}
        onToggle={() => {}}
        needing={new Set()}
        palette={GROUP_PALETTE}
        onNewSessionIn={() => {}}
        onRename={() => {}}
        onRecolor={() => {}}
        onSetHidden={() => {}}
        onRemove={() => {}}
        jobs={[]}
        stats={s}
        onUpdateWorktree={(f) => calls.push(`update:${f}`)}
        onOpenPr={(f) => calls.push(`pr:${f}`)}
        onMergeLocal={(f) => calls.push(`merge:${f}`)}
        onRemoveWorktree={(f) => calls.push(`remove:${f}`)}
      />
    );
  });
}

async function openMenu(folder: string): Promise<Map<string, HTMLButtonElement>> {
  const btn = document.querySelector<HTMLButtonElement>(`[data-project-worktree="${folder}"] [data-worktree-menu]`)!;
  await act(async () => {
    btn.click();
  });
  return new Map(
    [...document.querySelectorAll<HTMLButtonElement>('[data-group-menu-item]')].map((b) => [b.dataset.groupMenuItem!, b])
  );
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

describe('ProjectCard: finishing a worktree', () => {
  it('shows ↑ahead ↓behind and +/− lines beside a worktree, and nothing for one with none', async () => {
    await mount(stats(true), []);
    const fix = document.querySelector('[data-project-worktree="/wt/fix"]')!;
    expect(fix.querySelector('[data-worktree-ahead-behind]')?.textContent).toBe('↑2 ↓3');
    expect(fix.querySelector('[data-worktree-lines]')?.textContent).toBe('+120 −8');
    expect(document.querySelector('[data-project-worktree="/r"] [data-worktree-numbers]')).toBeNull();
  });

  it('with a remote: Update (with the behind count), Push & open pull request…, Remove; no local merge', async () => {
    const calls: string[] = [];
    await mount(stats(true), calls);
    const items = await openMenu('/wt/fix');
    expect(items.get('update')?.textContent).toContain('Update from main');
    expect(items.get('update')?.textContent).toContain('3 behind');
    expect(items.has('pr')).toBe(true);
    expect(items.has('merge-local')).toBe(false);
    await act(async () => {
      items.get('remove-worktree')!.click();
    });
    expect(calls).toEqual(['remove:/wt/fix']);
  });

  it('without a remote: Merge into main locally instead of a pull request', async () => {
    const calls: string[] = [];
    await mount(stats(false), calls);
    const items = await openMenu('/wt/fix');
    expect(items.has('pr')).toBe(false);
    await act(async () => {
      items.get('merge-local')!.click();
    });
    expect(calls).toEqual(['merge:/wt/fix']);
  });

  it('the primary checkout on main cannot be updated from main, opened as a PR, or removed', async () => {
    await mount(stats(true), []);
    const items = await openMenu('/r');
    expect(items.get('update')?.getAttribute('aria-disabled')).toBe('true');
    expect(items.get('pr')?.getAttribute('aria-disabled')).toBe('true');
    expect(items.has('remove-worktree')).toBe(false);
  });
});
