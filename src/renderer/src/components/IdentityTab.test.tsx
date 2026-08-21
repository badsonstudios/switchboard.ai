// @vitest-environment jsdom
// The session tab strip, and the name it says (#264).
//
// lib/card-title holds the RULES (order, empty-is-absent, folder last segment).
// What it cannot see is whether this tab is subscribed to anything: the bug was
// that `IdentityTab` read `props.api.title`, a value dockview is handed once at
// `addPanel` and that nothing ever calls `setTitle` to update. So the rail
// renamed, the record renamed, the card header renamed (#250) — and the tab
// above it, plus the confirmation you get for closing it, went on saying the
// name the session was born with.
//
// The second case is the one that was red: a rename arriving AFTER mount, with
// the panel api untouched, exactly as it arrives in the app.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { IdentityTab, type CardParams } from './SessionGrid';
import { sessionStore } from '../store/session-store';
import type { IDockviewPanelProps } from 'dockview-react';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
const close = vi.fn();

/** A panel's props, with only the three things this tab touches: the birth-time
 *  title dockview keeps, the panel ID (which is what says whether the ✕ closes a
 *  document — #543), and `close()`. */
function panelProps(
  birthTitle: string | undefined,
  params: Partial<CardParams> | undefined,
  panelId = 'session-c1'
): IDockviewPanelProps<CardParams> {
  return {
    api: { id: panelId, title: birthTitle, close },
    params,
  } as unknown as IDockviewPanelProps<CardParams>;
}

async function mount(
  birthTitle: string | undefined,
  params: Partial<CardParams> | undefined,
  panelId?: string
): Promise<void> {
  await act(async () => {
    root!.render(<IdentityTab {...panelProps(birthTitle, params, panelId)} />);
  });
}

/** what the ✕ promises it will do */
function closeTitle(): string {
  return host.querySelector('button')?.getAttribute('title') ?? '';
}

/** the name on the tab: everything in it that is not the ✕ */
function tabText(): string {
  const all = host.textContent ?? '';
  const btn = host.querySelector('button')?.textContent ?? '';
  return (btn ? all.replace(btn, '') : all).trim();
}

function rename(cardId: string, title: string): Promise<void> {
  return act(async () => {
    sessionStore.setSessions([{ id: cardId, title, folder: 'C:\\Projects\\acme' }]);
  });
}

/** Publish a card's whole identity, the way `sessions:cards` does. */
function publishIdentity(
  cardId: string,
  identity: { title?: string; accent?: string; badge?: string }
): Promise<void> {
  return act(async () => {
    sessionStore.setSessions([
      { id: cardId, title: identity.title ?? 'acme', folder: 'C:\\Projects\\acme', ...identity },
    ]);
  });
}

/** The chip's accent dot: the only `aria-hidden` span it renders. */
function dotColor(): string {
  // The TYPE ARGUMENT, not an `as HTMLElement` on the result: `querySelector`
  // is `<E extends Element = Element>`, so an assertion here is an inference
  // site rather than the no-op it looks like (#255 T0).
  const dot = host.querySelector<HTMLElement>('span[aria-hidden]');
  return dot?.style.background ?? '';
}

describe('the session tab follows a rename (issue 264)', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    close.mockReset();
    sessionStore.setSessions([]);
    await initI18nForTests();
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
    vi.unstubAllGlobals();
    sessionStore.setSessions([]);
  });

  it('shows the store name over the one the panel was born with', async () => {
    await rename('c1', 'renamed');
    await mount('at-birth', { cardId: 'c1', title: 'at-birth', folder: 'C:\\Projects\\acme' });
    expect(tabText()).toBe('renamed');
  });

  it('re-renders when the rename lands after the tab is already up', async () => {
    // THE REGRESSION. Nothing about the panel changes here — `props.api.title`
    // is still 'at-birth' — so only a store subscription can move this text.
    await rename('c1', 'at-birth');
    await mount('at-birth', { cardId: 'c1', title: 'at-birth', folder: 'C:\\Projects\\acme' });
    expect(tabText()).toBe('at-birth');

    await rename('c1', 'renamed-live');
    expect(tabText()).toBe('renamed-live');
  });

  it('keeps the birth-time title while the store has no answer yet', async () => {
    // a card's tab mounts before the first `setSessions` lands
    await mount('at-birth', { cardId: 'c1', title: 'at-birth', folder: 'C:\\Projects\\acme' });
    expect(tabText()).toBe('at-birth');
  });

  it('leaves a derived tab alone — no cardId, so the store has nothing to say', async () => {
    // the diff panel's tab. It is the same component, and its dockview title is
    // the only name it has ever had
    await rename('c1', 'renamed');
    await mount('Changes — acme', { folder: 'C:\\Projects\\acme' });
    expect(tabText()).toBe('Changes — acme');
  });

  it('confirms the close under the CURRENT name, and honours a cancel', async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    await rename('c1', 'at-birth');
    await mount('at-birth', { cardId: 'c1', title: 'at-birth', folder: 'C:\\Projects\\acme' });
    await rename('c1', 'renamed-live');

    await act(async () => {
      host.querySelector('button')!.click();
    });
    expect(confirm).toHaveBeenCalledWith(
      'Close "renamed-live"? This ends the session and removes the card.'
    );
    expect(close).not.toHaveBeenCalled(); // it said no
  });

  it("the ✕ says what it will actually do, per kind of tab (#543)", async () => {
    // Every tab in the app used to be titled "Close (ends the session)". On a
    // card that is true and is why the click confirms. On a DOCUMENT tab it is
    // simply false — no session ends — and #530 made it load-bearing by making
    // the ✕ the only way to close a document at all. The Changes tab was
    // wrong in the same way and for longer.
    //
    // The rule is the one the click handler already branches on: a `cardId` is
    // exactly "closing this ends a session". Without a card, the panel id says
    // which of the other two it is.
    await rename('c1', 'acme');
    await mount('acme', { cardId: 'c1', title: 'acme', folder: 'C:\\Projects\\acme' }, 'session-c1');
    expect(closeTitle()).toBe('Close (ends the session)');

    await mount('README.md', { folder: 'C:\\Projects\\acme' }, 'doc-4');
    expect(closeTitle()).toBe('Close document');

    await mount('Changes — acme', { folder: 'C:\\Projects\\acme' }, 'diff-c1');
    expect(closeTitle()).toBe('Close');
  });

  it('a document tab closes WITHOUT a confirm — it ends nothing (#543)', async () => {
    // the string and the behaviour have to agree: "Close document" must not
    // then put up "this ends the session and removes the card".
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirm);
    await mount('README.md', { folder: 'C:\\Projects\\acme' }, 'doc-7');

    await act(async () => {
      host.querySelector('button')!.click();
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes a derived tab without asking — nothing ends with it', async () => {
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirm);
    await mount('Changes — acme', { folder: 'C:\\Projects\\acme' });

    await act(async () => {
      host.querySelector('button')!.click();
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// The same defect class as #264 above and as #261/#308 (a declared prop that no
// caller passes), and it needs the same kind of test: the RULE here is
// `IdentityChip`, which has rendered an accent dot and a badge correctly since
// it was written. What no test could see was whether the tab hands it anything.
// It did not — `<IdentityChip title={title} compact />` — so seven sessions all
// tabbed the same grey dot while their headers each drew a different accent.
//
// Every assertion below reads the real DOM through the real component, so
// dropping `accent=` or `badge=` at the render site turns them red. Verified by
// doing exactly that before keeping them.
describe('the session tab paints the card identity (issue 312)', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    close.mockReset();
    sessionStore.setSessions([]);
    await initI18nForTests();
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      root = null;
      await act(async () => r.unmount());
    }
    vi.unstubAllGlobals();
    sessionStore.setSessions([]);
  });

  it('paints the accent dot in the card colour, not the grey placeholder', async () => {
    await publishIdentity('c1', { title: 'acme', accent: 'var(--accent-1)' });
    await mount('acme', { cardId: 'c1', title: 'acme', folder: 'C:\\Projects\\acme' });
    // token strings, not hex: the repo's lint rule bans raw colours, and jsdom
    // hands a `var(--…)` background back verbatim (it cannot resolve custom
    // properties), which is exactly what makes it assertable here
    expect(dotColor()).toBe('var(--accent-1)');
    expect(dotColor()).not.toContain('--faint');
  });

  it('shows the language badge beside the name', async () => {
    await publishIdentity('c1', { title: 'acme', accent: 'var(--accent-1)', badge: 'TS' });
    await mount('acme', { cardId: 'c1', title: 'acme', folder: 'C:\\Projects\\acme' });
    expect(tabText()).toContain('TS');
  });

  it('gives two cards two different dots — the point of the accent', async () => {
    // THE USER-VISIBLE CLAIM. One card at a time can pass while every tab still
    // shares one colour, so this asserts the tabs can be told APART.
    await act(async () => {
      sessionStore.setSessions([
        { id: 'c1', title: 'acme', folder: 'C:\\a', accent: 'var(--accent-1)', badge: 'TS' },
        { id: 'c2', title: 'beta', folder: 'C:\\b', accent: 'var(--accent-2)', badge: 'PY' },
      ]);
    });
    await mount('acme', { cardId: 'c1', title: 'acme', folder: 'C:\\a' });
    const first = dotColor();
    await mount('beta', { cardId: 'c2', title: 'beta', folder: 'C:\\b' });
    expect(dotColor()).not.toBe(first);
    expect(first).toBe('var(--accent-1)');
    expect(dotColor()).toBe('var(--accent-2)');
  });

  it('follows a re-assignment after the tab is already up', async () => {
    // The store subscription, not a mount-time snapshot: nothing about the panel
    // changes here, exactly as in the rename regression above.
    await publishIdentity('c1', { title: 'acme', accent: 'var(--accent-1)', badge: 'TS' });
    await mount('acme', { cardId: 'c1', title: 'acme', folder: 'C:\\Projects\\acme' });
    expect(dotColor()).toBe('var(--accent-1)');

    await publishIdentity('c1', { title: 'acme', accent: 'var(--accent-2)', badge: 'PY' });
    expect(dotColor()).toBe('var(--accent-2)');
    expect(tabText()).toContain('PY');
    expect(tabText()).not.toContain('TS');
  });

  it('keeps the grey dot for a session that genuinely has no accent', async () => {
    // Not every card has one — a suspended card restored before its record was
    // read has neither. The chip's own fallback must survive the wiring.
    await publishIdentity('c1', { title: 'acme' });
    await mount('acme', { cardId: 'c1', title: 'acme', folder: 'C:\\Projects\\acme' });
    expect(dotColor()).toBe('var(--faint)');
    expect(tabText()).toBe('acme'); // and no badge
  });

  it('leaves a derived tab grey — no cardId, so the store has no identity for it', async () => {
    await publishIdentity('c1', { title: 'acme', accent: 'var(--accent-1)', badge: 'TS' });
    await mount('Changes — acme', { folder: 'C:\\Projects\\acme' });
    expect(dotColor()).toBe('var(--faint)');
    expect(tabText()).toBe('Changes — acme');
  });
});
