// @vitest-environment jsdom
// Another session uses the same port or database (#1507): the Feed's one quiet
// warning line, with the fix in words.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { feedBlockRenderers } from './feed-blocks';
import type { FeedBlockDto } from '../lib/feed';
import { blockVisible } from '../lib/feed';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

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

type Clash = NonNullable<FeedBlockDto['clash']>;
const block = (clash: Partial<Clash>): FeedBlockDto => ({
  seq: 1,
  kind: 'clash',
  clash: { resource: 'port', cause: 'started', value: '3000', other: 'api', otherFolder: '/home/me/repo', ...clash },
  sidechain: false,
});

function renderBlock(b: FeedBlockDto): Element {
  const r = feedBlockRenderers.filter((x) => x.matches(b)).sort((a, z) => a.order - z.order)[0];
  act(() => root.render(<>{r.render(b)}</>));
  return host.querySelector('[data-clash-line]')!;
}

describe('the clash line', () => {
  it('two servers on one port: names the other session and the fix', () => {
    const line = renderBlock(block({}));
    expect(line.getAttribute('data-clash-cause')).toBe('started');
    expect(line.textContent).toBe(
      'api (repo) already started a server on port 3000. If both run at once, one of them will fail. Give this worktree its own port (PORT in .env, or --port).'
    );
    expect(line.getAttribute('title')).toContain('/home/me/repo');
    expect(line.getAttribute('title')).toContain('nothing was stopped or changed');
  });

  it('the same database in two worktrees', () => {
    const line = renderBlock(
      block({ resource: 'database', cause: 'config', value: 'app_dev on localhost:5432', setting: 'DATABASE_URL', file: '.env' })
    );
    expect(line.getAttribute('data-clash-resource')).toBe('database');
    expect(line.textContent).toBe(
      "This folder's .env points DATABASE_URL at the same local database as api (repo): app_dev on localhost:5432. Changes and test data from one will show up in the other. Give this worktree its own database in .env."
    );
  });

  it('a port in use that the other folder is set to', () => {
    const line = renderBlock(block({ cause: 'in-use', setting: 'PORT', file: '.env.local' }));
    expect(line.textContent).toBe(
      'Port 3000 is already in use, and api (repo) has PORT=3000 in its .env.local. Give this worktree its own PORT in .env.local.'
    );
  });

  it('is shown at every Feed setting', () => {
    expect(blockVisible(block({}), 'quiet')).toBe(true);
    expect(blockVisible(block({}), 'normal')).toBe(true);
  });
});
