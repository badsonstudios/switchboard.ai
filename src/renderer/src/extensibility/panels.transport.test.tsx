// @vitest-environment jsdom
// The Terminal tab's answer for a session that has no terminal (#419, from the
// #404 audit; the surface itself is P2-E18-08b).
//
// A stream session has no PTY, so xterm would open on nothing and paint an
// empty black rectangle — technically correct and indistinguishable from a
// broken terminal, which is the failure #125 was about. The panel therefore
// branches on `ctx.transport` and renders a NOTICE instead.
//
// That branch was e2e-only. It is one `?:` inside a contribution, and the two
// ways it rots are cheap to make and expensive to see: flipping the condition
// (every PTY session loses its terminal, every stream session gets a black
// box), or letting the notice fall back to the PTY branch for an unknown
// transport, which is the empty-rectangle bug again for exactly the sessions
// whose transport we could not resolve.
//
// The panel is reached through the REAL registry, the way the card reaches it
// (`listPanels`), so a contribution that stops being registered — or is
// re-ordered out of the Terminal slot — is red here rather than in Playwright.
// `StreamTerminalNotice` is deliberately not exported: the branch, not the
// component, is the thing #419 asks to pin, and it is asserted from the
// outside exactly as the card sees it.
import { describe, it, expect, beforeAll } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../i18n/locales/en.json';
import { createRendererRegistry } from '../bootstrap';
import { listPanels } from './panels';
import { TerminalPane } from '../components/TerminalPane';
import type { PanelContext } from './contributions';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const registry = createRendererRegistry();

/** The Terminal contribution, as the card's strip finds it. */
function terminalPanel(): ReturnType<typeof listPanels>[number] {
  const p = listPanels(registry).find((x) => x.id === 'terminal');
  if (!p) throw new Error('no Terminal panel is registered');
  return p;
}

function ctx(over: Partial<PanelContext>): PanelContext {
  return {
    sessionId: 's1',
    cardId: 'c1',
    visible: true,
    dockEpoch: 0,
    theme: 'midnight',
    colorScheme: 'dark',
    changed: 0,
    setView: () => {},
    ...over,
  };
}

/** What the panel renders, WITHOUT mounting it — the PTY branch builds a real
 *  xterm, which jsdom has no canvas for. The element's `type` is the identity
 *  of the component that would mount, which is the whole question here. */
function renderedType(transport: PanelContext['transport']): unknown {
  const el = terminalPanel().render(ctx({ transport }));
  return (el as React.ReactElement | null)?.type;
}

/** Mount what the panel renders and hand back the host. */
function draw(transport: PanelContext['transport']): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(terminalPanel().render(ctx({ transport })));
  });
  return host;
}

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

describe('the Terminal tab on a stream session (StreamTerminalNotice)', () => {
  it('says there is no terminal, in the words en.json holds', () => {
    const text = draw('stream').textContent ?? '';
    expect(text).toContain(en.terminal.streamTitle);
    expect(text).toContain(en.terminal.streamBody);
    // the copy earns its place: it says what the user GAINS, not only what is
    // missing, and it names the way back
    expect(text).toMatch(/permission requests appear in this window/i);
    expect(text).toMatch(/⋯ menu/);
  });

  it('does not build an xterm for a session that has no PTY', () => {
    // the load-bearing half: not "a notice appeared" but "the terminal did
    // not". A TerminalPane here opens xterm on a session id that no PTY
    // answers — the empty black rectangle this branch exists to prevent.
    expect(renderedType('stream')).not.toBe(TerminalPane);
    expect(draw('stream').querySelector('.xterm')).toBeNull();
  });

  it('still gives a PTY session its real terminal', () => {
    // the other half of the same `?:`. Not mounted: the assertion is which
    // component the card would mount, and mounting xterm needs a canvas.
    expect(renderedType('pty')).toBe(TerminalPane);
  });

  it('treats an unresolved transport as a terminal, never as a notice', () => {
    // `ctx.transport` is `live?.transport`, so it is undefined for the frames
    // before main has answered. Showing "no terminal for this session" then
    // would be a claim we cannot support — and it would stick, because the
    // notice is not something the user can retry.
    expect(renderedType(undefined)).toBe(TerminalPane);
  });

  it('keeps the Terminal panel mounted whichever transport it drew', () => {
    // `keepMounted` is why the branch is reached at all on a card sitting on
    // another tab — and why unmounting it would throw away the user's
    // scrollback. Pinned here because the branch above is meaningless if the
    // panel stops being rendered when it is not the active tab.
    expect(terminalPanel().keepMounted).toBe(true);
  });
});
