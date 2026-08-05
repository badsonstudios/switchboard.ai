// @vitest-environment jsdom
// The component half of the status pill's contrast promise (#221).
//
// tokens.drift.test.ts measures the RULE: `color: var(--pill-ink)` over 14% of
// `var(--pill-hue)`, for every ramp position in every shipped theme. What it
// cannot see is which value each of those two placeholders receives, and that
// is decided here — swap the two lines in StatusPill and the pill paints the
// raw hue on a tint of itself again, which is #221 verbatim, with the whole
// drift suite still green. This is the file that makes that swap fail.
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { StatusPill } from './StatusPill';
import { presentStatus, STATUS_TOKENS } from '../lib/rail-view';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;

async function mount(status?: string): Promise<HTMLElement> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<StatusPill status={status} label="state" />);
  });
  return host.querySelector<HTMLElement>('.status-pill')!;
}

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
  document.body.innerHTML = '';
});

describe('the status pill hands the rule the pair it promises', () => {
  it.each(STATUS_TOKENS)('paints %s with that status’s ink, never its hue', async (token) => {
    const el = await mount(token);
    expect(el.style.getPropertyValue('--pill-ink')).toBe(`var(--status-${token}-ink)`);
    expect(el.style.getPropertyValue('--pill-hue')).toBe(`var(--status-${token})`);
    expect(el.dataset.status).toBe(token);
  });

  it('folds the two statuses the ramp has no position for', async () => {
    // `starting` and `suspended` are real session states with no hue of their
    // own. The private table this replaced gave `suspended` --faint, which has
    // no ink token at all — the word was unreadable BECAUSE the colour it used
    // was outside the ramp.
    expect((await mount('starting')).dataset.status).toBe(presentStatus('starting').token);
    expect((await mount('suspended')).dataset.status).toBe('idle');
    expect((await mount('suspended')).style.getPropertyValue('--pill-ink')).toBe(
      'var(--status-idle-ink)'
    );
  });

  it('fails open on a status nobody has heard of', async () => {
    // §4: our blind spot must read as quiet, never as an alarm — and it must
    // still be a real pair, or the pill paints with an undefined property
    const el = await mount('compacting');
    expect(el.dataset.status).toBe('idle');
    expect(el.style.getPropertyValue('--pill-hue')).toBe('var(--status-idle)');
    expect(el.style.getPropertyValue('--pill-ink')).toBe('var(--status-idle-ink)');
  });

  it('carries the word, not only the colour', async () => {
    // the state is legible before any colour is read (§5.20) — the same reason
    // the collapsed row spells its state out
    expect((await mount('crashed')).textContent).toBe('state');
  });
});
