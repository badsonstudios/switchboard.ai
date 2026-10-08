// @vitest-environment jsdom
// The sessions strip across the top — its frame (#1143).
//
// The frame has three things to get right before any group or pill exists: it
// is not there at all unless asked for, its one total is the count it is handed
// (and is absent, not "0 need you", when nobody is waiting), and its row never
// says "no sessions" over a workspace that has some.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import { SessionsStrip } from './SessionsStrip';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
const noop = (): void => {};

type StripProps = React.ComponentProps<typeof SessionsStrip>;

async function mount(over: Partial<StripProps> = {}): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SessionsStrip
        shown
        sessionCount={3}
        groupCount={0}
        needCount={0}
        onCreateGroup={noop}
        onNewSession={noop}
        {...over}
      />
    );
  });
  return host;
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('the sessions strip frame (issue 1143)', () => {
  it('renders nothing at all unless it is shown', async () => {
    const host = await mount({ shown: false });
    expect(host.innerHTML).toBe('');
  });

  it('puts "+ group", "+ session" and then the total on the line, in that order', async () => {
    const host = await mount({ needCount: 7 });
    const line = host.querySelector('[data-strip-line]')!;
    expect(Array.from(line.children).map((c) => c.textContent)).toEqual([
      i18next.t('rail.addGroup'),
      i18next.t('strip.addSession'),
      i18next.t('urgency.needYou', { n: 7 }),
    ]);
  });

  it('shows no total when nobody is waiting, rather than a zero', async () => {
    const host = await mount({ needCount: 0 });
    expect(host.querySelector('[data-strip-need]')).toBeNull();
  });

  it('creates a group under the default name and asks for a new session', async () => {
    const said: string[] = [];
    const host = await mount({
      onCreateGroup: (name) => said.push(`group:${name}`),
      onNewSession: () => said.push('session'),
    });
    await act(async () => host.querySelector<HTMLElement>('[data-strip-add-group]')!.click());
    await act(async () => host.querySelector<HTMLElement>('[data-strip-add-session]')!.click());
    expect(said).toEqual([`group:${i18next.t('rail.newGroup')}`, 'session']);
  });

  it('counts one waiting session in the singular', async () => {
    // the wording the lamps row uses, not the rail footer's, which has no
    // singular and would read "1 need you"
    const host = await mount({ needCount: 1 });
    expect(host.querySelector('[data-strip-need]')!.textContent).toBe('1 needs you');
  });

  it('says "No sessions yet" only when there are none', async () => {
    const none = await mount({ sessionCount: 0 });
    const empty = none.querySelector<HTMLElement>('[data-strip-empty]')!;
    expect(empty.dataset.stripEmpty).toBe('none');
    expect(empty.textContent).toBe(i18next.t('rail.empty'));
  });

  it('says the sessions are not listed yet when there are some', async () => {
    // an empty row over a workspace full of sessions would read as "your
    // sessions are gone"; until the entries land the row says what is true
    const host = await mount({ sessionCount: 3 });
    const pending = host.querySelector<HTMLElement>('[data-strip-empty]')!;
    expect(pending.dataset.stripEmpty).toBe('pending');
    expect(pending.textContent).toBe(i18next.t('strip.pending', { count: 3, groups: 0 }));
    expect(pending.textContent).not.toContain(i18next.t('rail.empty'));
  });

  it('shows a new group in its words, so "+ group" visibly did something', async () => {
    // groups are not drawn yet; the count is the only feedback the button has.
    // That includes an otherwise empty workspace, where "No sessions yet"
    // would hide the group that was just made.
    const before = await mount({ sessionCount: 0, groupCount: 0 });
    expect(before.querySelector('[data-strip-empty]')!.textContent).toBe(i18next.t('rail.empty'));
    await act(async () => root!.unmount());
    root = null;

    const after = await mount({ sessionCount: 0, groupCount: 1 });
    const words = after.querySelector<HTMLElement>('[data-strip-empty]')!;
    expect(words.dataset.stripEmpty).toBe('pending');
    expect(words.textContent).toContain('1 group');
  });
});
