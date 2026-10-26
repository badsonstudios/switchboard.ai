// @vitest-environment jsdom
// No ✓✓ on a session's row or pill, allow-all or not (#1462).
//
// #1434 put a quiet ✓✓ mark on the tab, the rail row and the strip pill of a
// session on "Allow all (this session)". Dan saw two ticks beside some names,
// did not know what they meant, and asked for them gone. The mode chip under
// the prompt box still says "ask · allow all" (`autonomy-tooltips.test.tsx`).
// These pin that the row and the pill say nothing about it, by glyph or by
// name. The TAB lives inside a live dockview, so it is covered by the e2e
// (`stream-approval.spec.ts`).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionStore } from '../store/session-store';
import { SessionRow } from './SessionRow';
import { StripPill } from './StripPill';
import type { RailSession } from '../model/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const noop = (): void => {};
const SESSION: RailSession = { id: 'card-A', title: 'switchboard', status: 'idle' };
let root: Root | null = null;

async function mount(el: React.JSX.Element): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(el));
  return host;
}

const row = (
  <SessionRow
    session={SESSION}
    needsYou={false}
    selected={false}
    pinned={false}
    waiting={0}
    depth={undefined}
    editing={false}
    draft=""
    onDraftChange={noop}
    onFocus={noop}
    onClose={noop}
    onRename={noop}
    onStartRename={noop}
    onEndRename={noop}
  />
);

const pill = (
  <StripPill
    session={SESSION}
    needsYou={false}
    selected={false}
    pinned={false}
    waiting={0}
    nested={false}
    folded={false}
    flash={false}
    onFocus={noop}
  />
);

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  sessionStore.forgetCardLiveIds('card-A');
  sessionStore.mapLiveToCard('live-A', 'card-A');
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
  sessionStore.forgetCardLiveIds('card-A');
});

describe.each([
  ['the rail row', row, '[data-rail-open]'],
  ['the strip pill', pill, '[data-strip-pill]'],
])('%s', (_name, el, named) => {
  it('shows no ✓✓ and says nothing of allow-all, with allow-all on', async () => {
    const host = await mount(el);
    const before = host.textContent;
    const nameBefore = host.querySelector(named)!.getAttribute('aria-label');
    await act(async () => sessionStore.setAllowAllFromMain('live-A', true));
    expect(sessionStore.isAllowAll('live-A')).toBe(true);
    expect(host.querySelector('[data-allow-all-mark]')).toBeNull();
    expect(host.textContent).not.toContain('✓✓');
    // nothing about the session's look or its spoken name moved
    expect(host.textContent).toBe(before);
    expect(host.querySelector(named)!.getAttribute('aria-label')).toBe(nameBefore);
    expect(nameBefore).not.toMatch(/allowing all/);
  });
});
