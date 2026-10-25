// @vitest-environment jsdom
// The identity chip after #1433: a mark and a name, and nothing after the name.
//
// Until #1433 this file held the §5.11 project-type badge's colours (#269) —
// the accent as the badge's FIELD, a neutral ink on top. The owner had the
// badge removed outright (2026-10-23: "TS" told him nothing and the boxed "·"
// for every other folder read as a glitch), so what is left to hold here is
// that it STAYS gone at the component, whatever a caller hands it, and that the
// name is the last thing in the chip — which is what lets it sit where the box
// used to be, with no trailing gap.
//
// The tab's wiring (that the store's accent reaches the chip) is
// IdentityTab.test.tsx's; the card headers are the SessionGrid.*-header tests'.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { IdentityChip, identityWash } from './IdentityChip';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
  host.remove();
});

async function render(el: React.JSX.Element): Promise<void> {
  await act(async () => root!.render(el));
}

describe('the identity chip (issue 1433)', () => {
  it('draws a dot and the name, and no project-type badge', async () => {
    await render(<IdentityChip title="acme" accent="var(--accent-pink)" compact />);
    expect(host.querySelector('[data-testid="identity-badge"]')).toBeNull();
    expect(host.textContent).toBe('acme');
    const chip = host.firstElementChild!;
    // the dot, then the name: two children, nothing else
    expect(chip.children).toHaveLength(2);
    expect(chip.lastElementChild!.classList.contains('identity-chip-title')).toBe(true);
  });

  it('puts the name last when a mark replaces the dot, too', async () => {
    await render(
      <IdentityChip title="acme" accent="var(--accent-pink)" mark={<i data-mark />} compact />
    );
    const chip = host.firstElementChild!;
    expect(chip.firstElementChild!.hasAttribute('data-mark')).toBe(true);
    expect(chip.lastElementChild!.classList.contains('identity-chip-title')).toBe(true);
    expect(chip.children).toHaveLength(2);
  });
});

describe('identityWash (#905)', () => {
  it('mixes the accent into the panel at the shared strength', () => {
    expect(identityWash('var(--accent-pink)')).toBe(
      'color-mix(in srgb, var(--accent-pink) var(--identity-wash), var(--panel2))'
    );
  });

  it('is the plain panel for a card with no accent yet', () => {
    expect(identityWash(undefined)).toBe('var(--panel)');
  });
});
