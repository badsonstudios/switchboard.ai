// @vitest-environment jsdom
// The pins for #673: the per-launch `identifierPrefix` that finishes #654.
//
// #654's scan (`markdown.test.tsx`) pins that no literal id is typed into JSX
// again; what it could NOT pin is the counter — React numbers `useId` clients
// from a module-global counter starting at zero, so every id was one of a few
// hundred strings any rendered document could plant ahead of time. The prefix
// is the closure, and these four tests are its net: the generator's shape, its
// per-call randomness, the fact that the prefix actually reaches the ids React
// mints, and the one line of `main.tsx` wiring that puts it on the app's root.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { rootIdentifierPrefix } from './root-identity';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
  document.body.innerHTML = '';
});

describe('rootIdentifierPrefix', () => {
  it('mints an id-safe prefix in the documented shape', () => {
    // [0-9a-f] plus the trailing `_` — nothing that needs escaping in a CSS
    // selector, nothing an IDREF can't carry. The shape is asserted exactly so
    // a refactor that quietly shrinks the random part goes red here.
    expect(rootIdentifierPrefix()).toMatch(/^sb[0-9a-f]{16}_$/);
  });

  it('mints a DIFFERENT namespace on every call', () => {
    // Per-launch is the whole point: a string published in one launch (or
    // planted in a document before launch) names nothing in the next. Twenty
    // draws with no collision is not a proof of entropy, but it is red the day
    // someone replaces the random part with a constant — which is the only
    // regression a unit test can actually catch here.
    const seen = new Set(Array.from({ length: 20 }, () => rootIdentifierPrefix()));
    expect(seen.size).toBe(20);
  });

  it('lands inside the ids React mints under a prefixed root', async () => {
    // The mechanism, not the wiring: `createRoot(host, { identifierPrefix })`
    // must put the prefix inside the ids `useId` returns, or the one line in
    // `main.tsx` buys nothing. React composes `_<prefix>r_<n>_`, but the exact
    // format is React's to change — what this pins is that the random part is
    // IN the id, which is what makes the id unguessable.
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const prefix = rootIdentifierPrefix();
    const Probe = (): React.JSX.Element => <i data-probe={React.useId()} />;
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host, { identifierPrefix: prefix });
    await act(async () => {
      root!.render(<Probe />);
    });
    const minted = host.querySelector('i')?.getAttribute('data-probe') ?? '';
    expect(minted).toContain(prefix);
  });

  it('is wired onto the app root in main.tsx', () => {
    // The source assertion that keeps the one line from being deleted. A typo'd
    // option name is already a type error (`RootOptions` has no excess-property
    // escape here); what typechecking cannot catch is the option being dropped
    // in a refactor, and this is the test that goes red when it is.
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src', 'renderer', 'src', 'main.tsx'),
      'utf8'
    );
    expect(src).toMatch(/createRoot\([\s\S]*?\{\s*identifierPrefix:\s*rootIdentifierPrefix\(\)/);
  });
});
