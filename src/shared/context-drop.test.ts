// The vocabulary a context drop is spoken in (P2-E11-10, §5.5).
//
// Small surface, and two of these tests exist because the thing they pin is a
// SPEC CLAIM rather than a behaviour: §5.5 says Level 2 is the default, and a
// default is exactly the kind of decision that gets quietly re-typed as a
// literal in a component and then changed by someone tidying up. Pinned against
// the constant both sides import.
import { describe, it, expect } from 'vitest';
import {
  CONTEXT_DND_TYPE,
  CONTEXT_FIDELITIES,
  DEFAULT_FIDELITY,
  isContextOffer,
  type ContextOffer,
} from './context-drop';

const offer = (over: Partial<ContextOffer> = {}): ContextOffer => ({
  from: { id: 'sess-a', name: 'TradingApp' },
  coverage: 'whole',
  options: [{ id: 'package', tokens: 3100, empty: false, text: '# Context from @TradingApp\n' }],
  ...over,
});

describe('what §5.5 asks the dialog to offer', () => {
  it('offers exactly the three fidelities §5.5 names, in its order', () => {
    expect(CONTEXT_FIDELITIES).toEqual(['state', 'package', 'excerpt']);
  });

  it('defaults to the summary handoff — §5.5 says so in as many words', () => {
    expect(DEFAULT_FIDELITY).toBe('package');
    // …and it is one of the three, which a literal typed somewhere else could
    // stop being without anything failing.
    expect(CONTEXT_FIDELITIES).toContain(DEFAULT_FIDELITY);
  });

  it('drags under a type nothing else in the world advertises', () => {
    expect(CONTEXT_DND_TYPE).toBe('application/x-switchboard-context');
    // Distinct from the rail's card drag, which is the one it could plausibly
    // be confused with — the composer accepts one and not the other.
    expect(CONTEXT_DND_TYPE).not.toBe('application/x-switchboard-card');
  });
});

describe('isContextOffer — the boundary guard', () => {
  it('accepts a well-formed offer', () => {
    expect(isContextOffer(offer())).toBe(true);
  });

  it('rejects the things a broken bridge actually hands back', () => {
    for (const bad of [null, undefined, 42, 'offer', [], {}]) {
      expect(isContextOffer(bad)).toBe(false);
    }
  });

  it('rejects an IPC REFUSAL, which is the truthy object this must not admit', () => {
    // The whole reason the renderer launders with `answered` first — but a
    // guard that would pass a refusal makes that laundering the only thing
    // standing between a refusal and a dialog rendering it.
    expect(isContextOffer({ __ipcRefused: true, channel: 'sessions:contextOffer', reason: 'not-granted' })).toBe(
      false
    );
  });

  it('rejects an offer with NO options rather than opening an empty dialog', () => {
    expect(isContextOffer(offer({ options: [] }))).toBe(false);
  });

  it('rejects an unknown coverage — it decides which caveat the user is shown', () => {
    expect(isContextOffer({ ...offer(), coverage: 'partial' })).toBe(false);
  });

  it('rejects an unknown fidelity id — the dialog would render a row it has no words for', () => {
    expect(
      isContextOffer(offer({ options: [{ id: 'everything', tokens: 1, empty: false, text: 'x' }] as never }))
    ).toBe(false);
  });

  it('rejects a non-finite token count, which would render as "~NaN tokens"', () => {
    expect(isContextOffer(offer({ options: [{ id: 'package', tokens: NaN, empty: false, text: 'x' }] }))).toBe(
      false
    );
  });

  it('rejects a nameless or idless source — both reach the block the user reads', () => {
    expect(isContextOffer(offer({ from: { id: '', name: 'A' } }))).toBe(false);
    expect(isContextOffer(offer({ from: { id: 'a' } as never }))).toBe(false);
  });
});
