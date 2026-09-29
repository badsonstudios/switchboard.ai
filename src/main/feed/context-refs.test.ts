import { describe, expect, it } from 'vitest';
import { CONTEXT_REF_LENGTH } from '../../shared/injected-context';
import { ContextRefs, REF_CAP } from './context-refs';

describe('ContextRefs — #830’s forgery register', () => {
  it('a minted ref is known to the session it was minted for, and to no other', () => {
    const refs = new ContextRefs();
    const ref = refs.mint('sess-a');
    expect(refs.isMinted('sess-a', ref)).toBe(true);
    // The register is per session on purpose: a ref minted for A proves nothing
    // about a turn in B, and treating it as proof would let one card's history
    // vouch for another's.
    expect(refs.isMinted('sess-b', ref)).toBe(false);
  });

  it('says no to a ref nobody minted — the answer the whole guard rests on', () => {
    const refs = new ContextRefs();
    refs.mint('sess-a');
    expect(refs.isMinted('sess-a', 'deadbeef')).toBe(false);
    expect(refs.isMinted('sess-a', '')).toBe(false);
  });

  it('says no for a session that has never sent anything', () => {
    expect(new ContextRefs().isMinted('nobody', 'a1b2c3d4')).toBe(false);
  });

  it('mints a distinct lowercase-hex ref of the marker’s length every time', () => {
    const refs = new ContextRefs();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const ref = refs.mint('sess-a');
      expect(ref).toMatch(new RegExp(`^[0-9a-f]{${CONTEXT_REF_LENGTH}}$`));
      seen.add(ref);
    }
    // Not a randomness test — a check that the value is not a constant or a
    // counter that a transcript could predict. 200 draws from 2^32 collide with
    // probability ~5e-6, so a repeat here means something is badly wrong.
    expect(seen.size).toBe(200);
  });

  it('keeps the newest REF_CAP refs and forgets past them — expanded, never forged', () => {
    const refs = new ContextRefs();
    const first = refs.mint('sess-a');
    for (let i = 0; i < REF_CAP; i++) refs.mint('sess-a');
    expect(refs.isMinted('sess-a', first)).toBe(false);
  });

  it('forget drops a closed session’s refs', () => {
    const refs = new ContextRefs();
    const ref = refs.mint('sess-a');
    refs.forget('sess-a');
    expect(refs.isMinted('sess-a', ref)).toBe(false);
  });

  it('guardFor is the same answer, bound to one session', () => {
    const refs = new ContextRefs();
    const ref = refs.mint('sess-a');
    const guard = refs.guardFor('sess-a');
    expect(guard(ref)).toBe(true);
    expect(guard('deadbeef')).toBe(false);
    // Bound, not snapshotted: a ref minted after the closure was handed out is
    // still recognised, which is what makes it safe to build one per derivation.
    expect(guard(refs.mint('sess-a'))).toBe(true);
  });
});
