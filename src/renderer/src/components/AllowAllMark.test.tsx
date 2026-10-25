// @vitest-environment jsdom
// The quiet allow-all mark on a session's row and pill (#1434).
//
// "Allow all (this session)" makes main answer every gated call Allow, silently,
// until the session restarts. The mode chip under the prompt box says so in
// words (`autonomy-tooltips.test.tsx`); these pin the smaller cue on the places
// a session is listed WITHOUT being open, and that the cue comes and goes with
// main's pushed truth. The tab carries the same component; it lives inside a
// live dockview, so it is covered by the e2e (`stream-approval.spec.ts`).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
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
  it('wears no mark while the session asks', async () => {
    const host = await mount(el);
    expect(host.querySelector('[data-allow-all-mark]')).toBeNull();
    expect(host.querySelector(named)!.getAttribute('aria-label')).not.toContain('allowing all');
  });

  it('wears the mark, and says it in its name, while allow-all is on — and drops both on revoke', async () => {
    const host = await mount(el);
    await act(async () => sessionStore.setAllowAllFromMain('live-A', true));
    const mark = host.querySelector<HTMLElement>('[data-allow-all-mark="card-A"]');
    expect(mark?.textContent).toBe(en.autonomy.allowAll.mark);
    expect(mark?.title).toBe(en.autonomy.allowAll.markHint);
    expect(host.querySelector(named)!.getAttribute('aria-label')).toContain('allowing all without asking');

    await act(async () => sessionStore.setAllowAllFromMain('live-A', false));
    expect(host.querySelector('[data-allow-all-mark]')).toBeNull();
  });
});
