// @vitest-environment jsdom
// The revoke surface (P2-E22-03, #974).
//
// WHAT THIS GUARDS is a promise about what a user can UNDO. "Always allow for
// this session" had no way back from #319 until this item — the grant was
// cleared only when the session died — and the point of the section is that a
// standing approval is visible and reversible. So the assertions are: it lists
// both rungs, it lists them when there are none, each row revokes the thing it
// names, and the two rungs revoke independently.
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { StandingGrantsSection, grantCount, tailOf, useStandingGrants } from './StandingGrants';
import type { StandingGrants } from '../../../shared/ipc/permissions';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let revoked: Array<[string, string, string | undefined]> = [];

function bridge(over: Record<string, unknown> = {}): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      standingGrants: () => Promise.resolve({ allowAll: false, files: [] }),
      onStandingGrants: () => () => {},
      revokeStandingGrant: (id: string, kind: string, p?: string) => {
        revoked.push([id, kind, p]);
        return Promise.resolve(true);
      },
      ...over,
    },
  };
}

async function mount(grants: StandingGrants): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<StandingGrantsSection liveId="live-1" grants={grants} />);
  });
  return host;
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  revoked = [];
  bridge();
  await initI18nForTests();
});
afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

const rows = (h: HTMLElement, sel: string): HTMLElement[] => [...h.querySelectorAll<HTMLElement>(sel)];

describe('the standing-approvals section', () => {
  // ⚠️ THE EMPTY STATE IS A REQUIREMENT, not politeness. The defect being fixed
  // is a grant you cannot see; a section that appeared only when there was
  // something in it would be indistinguishable from the feature not existing,
  // and would teach a user nothing about where to look next time.
  it('renders when there is nothing to show, and says so', async () => {
    const host = await mount({ allowAll: false, files: [] });
    expect(host.querySelector('[data-testid="card-standing-grants"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="card-standing-grants-empty"]')).not.toBeNull();
    expect(host.textContent).toContain('asks every time');
  });

  it('lists the blanket grant FIRST, whatever else is standing', async () => {
    const host = await mount({ allowAll: true, files: ['/p/a.ts', '/p/b.ts'] });
    const all = host.querySelector('[data-testid="card-grant-all"]');
    const first = host.querySelector('[data-testid^="card-grant-"]');
    // It is the one most likely to have been set by accident and least likely
    // to be wanted; burying it under file paths would sort by nothing anyone
    // cares about.
    expect(first).toBe(all);
    expect(rows(host, '[data-testid="card-grant-file"]')).toHaveLength(2);
    expect(host.querySelector('[data-testid="card-standing-grants-empty"]')).toBeNull();
  });

  it('each row revokes exactly the grant it names', async () => {
    const host = await mount({ allowAll: true, files: ['/p/a.ts', '/p/b.ts'] });
    const click = (el: Element | null): Promise<void> =>
      act(async () => (el!.querySelector('button') as HTMLButtonElement).click());

    await click(host.querySelector('[data-grant-path="/p/b.ts"]'));
    await click(host.querySelector('[data-testid="card-grant-all"]'));

    expect(revoked).toEqual([
      ['live-1', 'file', '/p/b.ts'],
      ['live-1', 'all', undefined],
    ]);
  });

  // The gesture the whole item is sized around: a mis-clicked blanket grant
  // goes away WITHOUT taking the files the user meant with it.
  it('revoking the blanket grant does not touch the per-file ones', async () => {
    const host = await mount({ allowAll: true, files: ['/p/a.ts'] });
    await act(async () =>
      (
        host.querySelector('[data-testid="card-grant-all"] button') as HTMLButtonElement
      ).click()
    );
    expect(revoked).toEqual([['live-1', 'all', undefined]]);
  });

  it('the full path is on the control, not only in a tooltip', async () => {
    const host = await mount({ allowAll: false, files: ['/very/long/project/src/deep/a.ts'] });
    const btn = host.querySelector('[data-testid="card-grant-file"] button')!;
    expect(btn.getAttribute('aria-label')).toContain('/very/long/project/src/deep/a.ts');
    // …while the visible label is shortened, because a menu is ~200px wide
    expect(host.querySelector('[data-testid="card-grant-file"]')!.textContent).toContain('deep/a.ts');
  });

  it('a failed revoke does not take the card down (P6)', async () => {
    bridge({ revokeStandingGrant: () => Promise.reject(new Error('gone')) });
    const host = await mount({ allowAll: true, files: [] });
    await act(async () =>
      (
        host.querySelector('[data-testid="card-grant-all"] button') as HTMLButtonElement
      ).click()
    );
    expect(host.querySelector('[data-testid="card-grant-all"]')).not.toBeNull();
  });
});

describe('tailOf', () => {
  it('keeps the last two segments, which is what identifies a file', () => {
    expect(tailOf('/a/b/c/d.ts')).toBe('…/c/d.ts');
    expect(tailOf('C:\\p\\src\\a.ts')).toBe('…/src/a.ts');
  });
  it('leaves a short path alone rather than decorating it', () => {
    expect(tailOf('/p/a.ts')).toBe('/p/a.ts');
    expect(tailOf('a.ts')).toBe('a.ts');
  });
});

describe('grantCount', () => {
  it('counts both rungs, because the ⋯ marker speaks for both', () => {
    expect(grantCount({ allowAll: false, files: [] })).toBe(0);
    expect(grantCount({ allowAll: true, files: [] })).toBe(1);
    expect(grantCount({ allowAll: true, files: ['a', 'b'] })).toBe(3);
  });
});

describe('useStandingGrants', () => {
  function Probe(props: { liveId: string | null }): React.JSX.Element {
    const g = useStandingGrants(props.liveId);
    // `children` rather than a template in JSX: `react/jsx-no-literals` is on,
    // and the whole point of this probe is to read the hook's state as a string.
    return React.createElement('span', { 'data-testid': 'probe' }, `${g.allowAll}|${g.files.join(',')}`);
  }
  const read = (h: HTMLElement): string =>
    h.querySelector('[data-testid="probe"]')!.textContent ?? '';

  async function mountProbe(liveId: string | null): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Probe liveId={liveId} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    return host;
  }

  it('reads once on mount AND follows the push — neither alone is enough', async () => {
    let push: ((g: StandingGrants & { sessionId: string }) => void) | null = null;
    bridge({
      standingGrants: () => Promise.resolve({ allowAll: false, files: ['/p/a.ts'] }),
      onStandingGrants: (cb: (g: StandingGrants & { sessionId: string }) => void) => {
        push = cb;
        return () => {};
      },
    });
    const host = await mountProbe('live-1');
    // the READ half: a menu opened on a session granted earlier must not be blank
    expect(read(host)).toBe('false|/p/a.ts');

    // the PUSH half: anything else moving a grant must reach this list
    await act(async () => push!({ sessionId: 'live-1', allowAll: true, files: [] }));
    expect(read(host)).toBe('true|');
  });

  it('ignores a push for a DIFFERENT session', async () => {
    let push: ((g: StandingGrants & { sessionId: string }) => void) | null = null;
    bridge({
      onStandingGrants: (cb: (g: StandingGrants & { sessionId: string }) => void) => {
        push = cb;
        return () => {};
      },
    });
    const host = await mountProbe('live-1');
    await act(async () => push!({ sessionId: 'live-2', allowAll: true, files: ['/x'] }));
    expect(read(host)).toBe('false|');
  });

  // P6: a revoke surface is a nicety and may not cost the card. A bridge
  // without the namespace is an older preload — and, in this tree, most test
  // suites, which is how this was found: 39 of `SessionGrid.sound.test.tsx`'s
  // went red on `standingGrants is not a function`.
  it('survives a bridge that has never heard of it', async () => {
    (window as unknown as { switchboard: unknown }).switchboard = { sessions: {} };
    const host = await mountProbe('live-1');
    expect(read(host)).toBe('false|');
  });

  it('asks nothing at all for a card with no live session', async () => {
    const asked: string[] = [];
    bridge({
      standingGrants: (id: string) => {
        asked.push(id);
        return Promise.resolve({ allowAll: true, files: [] });
      },
    });
    const host = await mountProbe(null);
    expect(asked).toEqual([]);
    expect(read(host)).toBe('false|');
  });
});
