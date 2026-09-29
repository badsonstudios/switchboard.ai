// The register behind #830's forgery guard: which context markers are OURS.
//
// One instance per app, keyed by session, holding the refs `resolveMentions`
// minted for that session's sends. `deriveIntents` asks it whether a marker it
// found in a user turn is one we wrote; anything it has not heard of renders as
// the plain text it is.
//
// ── WHY A REGISTER RATHER THAN A SIGNATURE ─────────────────────────────────
//
// The obvious alternative is a keyed hash over the section body, which would
// need no per-session state and would survive a restart. It was rejected on two
// counts, and the second is the one that settles it:
//
//  * the body is CAPPED on its way into a block (`DerivationCaps.text`), so a
//    long section's stored text is not the text that was signed — the guard
//    would fail exactly on the blocks big enough to be worth collapsing;
//  * a key that survives a restart has to live on disk, and the adversary in
//    #830 is an agent running on this machine with a file read. A secret the
//    attacker can read is not a secret, so "survives a restart" and "cannot be
//    forged" were never available at the same time. The guard is the one that
//    matters; the fold state is not.
//
// ── THE BOUND ──────────────────────────────────────────────────────────────
//
// A session can send for weeks. Refs are kept newest-first up to `REF_CAP` per
// session, which is far more than the Feed's own `BLOCK_CAP` window can be
// showing at once — so a ref falls out of the register only well after the turn
// carrying it has fallen out of the view. Dropping one is safe in the only
// direction that matters: the section renders expanded.

import { randomBytes } from 'node:crypto';
import { CONTEXT_REF_LENGTH } from '../../shared/injected-context';

/** How many minted refs are remembered per session. */
export const REF_CAP = 200;

/**
 * Minted context refs, per session.
 *
 * NOT persisted and deliberately not — see the header. `forget` exists so a
 * closed session's refs go with it rather than accumulating for the life of the
 * process.
 */
export class ContextRefs {
  private readonly perSession = new Map<string, string[]>();

  /**
   * A fresh ref for one injected section of one send.
   *
   * `randomBytes`, not `Math.random`: this is the value a hostile transcript
   * must not be able to guess, and a PRNG seeded from the clock is guessable by
   * a process running on the same machine at the same time — which is precisely
   * the adversary.
   */
  mint(sessionId: string): string {
    const ref = randomBytes(Math.ceil(CONTEXT_REF_LENGTH / 2))
      .toString('hex')
      .slice(0, CONTEXT_REF_LENGTH);
    const refs = this.perSession.get(sessionId) ?? [];
    refs.unshift(ref);
    if (refs.length > REF_CAP) refs.length = REF_CAP;
    this.perSession.set(sessionId, refs);
    return ref;
  }

  /** Did we mint this ref, for this session? The whole of the guard. */
  isMinted(sessionId: string, ref: string): boolean {
    return this.perSession.get(sessionId)?.includes(ref) === true;
  }

  /**
   * The predicate `deriveIntents` takes, bound to one session.
   *
   * Handed out as a closure because the derivation is per line and the session
   * is per call site — and because a `deriveIntents` that took the whole
   * register would be a pure function holding a reference to app state, which is
   * the promise at the top of `blocks.ts`.
   */
  guardFor(sessionId: string): (ref: string) => boolean {
    return (ref) => this.isMinted(sessionId, ref);
  }

  forget(sessionId: string): void {
    this.perSession.delete(sessionId);
  }
}
