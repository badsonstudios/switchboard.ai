import { describe, expect, it } from 'vitest';
import { agentRunHeads } from './feed-groups';
import type { FeedBlockDto } from './feed';

let seq = 0;
function block(p: Partial<FeedBlockDto> = {}): FeedBlockDto {
  return { seq: ++seq, kind: 'assistant', sidechain: false, ...p };
}
/** A subagent block: sidechain, with an id, optionally named. */
function sub(agentId: string, agentName?: string): FeedBlockDto {
  return block({ sidechain: true, agentId, ...(agentName ? { agentName } : {}) });
}

describe('agentRunHeads', () => {
  it('captions nothing when nothing is attributed', () => {
    expect(agentRunHeads([block(), block(), block()]).size).toBe(0);
  });

  it('captions the FIRST block of a run and no other block in it', () => {
    const [a, b, c] = [sub('id1', 'Explore'), sub('id1'), sub('id1')];
    const heads = agentRunHeads([a, b, c]);
    expect([...heads.keys()]).toEqual([a.seq]);
    expect(heads.get(a.seq)).toEqual({ agentId: 'id1', name: 'Explore' });
  });

  it('names a run from a LATER block when its head is anonymous', () => {
    // The real shape: a subagent transcript opens with a `user` line, and
    // `attributionAgent` is on `assistant` lines only. Reading the head block's
    // name would leave every run in the app anonymous.
    const head = sub('id1'); // no name — the tool prompt
    const named = sub('id1', 'code-reviewer'); // the agent's first reply
    const heads = agentRunHeads([head, named]);
    expect(heads.get(head.seq)?.name).toBe('code-reviewer');
    expect(heads.has(named.seq)).toBe(false);
  });

  it('SEPARATES two interleaved agents — the bug this item exists for', () => {
    // What our merge of two concurrent subagent files actually produces:
    // blocks in tail-arrival order, alternating.
    const a1 = sub('idA', 'Explore');
    const b1 = sub('idB', 'Plan');
    const a2 = sub('idA');
    const b2 = sub('idB');
    const heads = agentRunHeads([a1, b1, a2, b2]);
    expect([...heads.keys()]).toEqual([a1.seq, b1.seq, a2.seq, b2.seq]);
    expect(heads.get(a2.seq)).toEqual({ agentId: 'idA', name: 'Explore' });
    expect(heads.get(b2.seq)).toEqual({ agentId: 'idB', name: 'Plan' });
  });

  it('a main-conversation block ENDS a run, so returning to the agent re-captions', () => {
    const a1 = sub('idA', 'Explore');
    const main = block();
    const a2 = sub('idA');
    const heads = agentRunHeads([a1, main, a2]);
    expect([...heads.keys()]).toEqual([a1.seq, a2.seq]);
  });

  it('names a SECOND run of the same agent that contains no named line', () => {
    // The discriminating case for "names are resolved per AGENT, not per run".
    // Resolved per run, `a2` below has no named block of its own and would
    // render a bare "Subagent" directly beneath the same agent's named
    // caption — the two captions disagreeing about one agent.
    const a1 = sub('idA', 'Explore');
    const main = block();
    const a2 = sub('idA');
    const heads = agentRunHeads([a1, main, a2]);
    expect(heads.get(a1.seq)?.name).toBe('Explore');
    expect(heads.get(a2.seq)?.name).toBe('Explore');
  });

  it('names a run from a name that only appears LATER in the list', () => {
    // Same rule, the other direction: the first run is captioned from a name
    // the agent does not utter until after the parent has interrupted it.
    const a1 = sub('idA');
    const main = block();
    const a2 = sub('idA', 'Explore');
    const heads = agentRunHeads([a1, main, a2]);
    expect(heads.get(a1.seq)?.name).toBe('Explore');
  });

  it('discriminates two CONCURRENT agents that share a name', () => {
    // Measured, not hypothetical: one session ran three overlapping
    // `deep-research-specialist`s. Without this they render one caption twice
    // and the separation is invisible.
    const a = sub('aaaaaa111', 'deep-research-specialist');
    const b = sub('bbbbbb222', 'deep-research-specialist');
    const heads = agentRunHeads([a, b]);
    expect(heads.get(a.seq)?.discriminator).toBe('aaaaaa');
    expect(heads.get(b.seq)?.discriminator).toBe('bbbbbb');
  });

  it('does NOT discriminate when the name is unambiguous', () => {
    // The common case, and the reason the field is optional: a hex suffix on
    // every caption would be noise on every session to serve the rare one.
    const a = sub('aaaaaa111', 'Explore');
    const b = sub('bbbbbb222', 'Plan');
    const heads = agentRunHeads([a, b]);
    expect(heads.get(a.seq)?.discriminator).toBeUndefined();
    expect(heads.get(b.seq)?.discriminator).toBeUndefined();
  });

  it('does not discriminate two runs of the SAME agent under one name', () => {
    // Same id twice is one agent interrupted, not two agents. A suffix here
    // would imply a distinction that does not exist.
    const a1 = sub('idA', 'Explore');
    const main = block();
    const a2 = sub('idA', 'Explore');
    const heads = agentRunHeads([a1, main, a2]);
    expect(heads.get(a1.seq)?.discriminator).toBeUndefined();
    expect(heads.get(a2.seq)?.discriminator).toBeUndefined();
  });

  it('lengthens the fragment when six characters are not enough', () => {
    // Six hex characters separate real ids essentially always — and
    // "essentially always" is how a caption ends up showing two agents the
    // same suffix.
    const a = sub('sharedXA', 'dup');
    const b = sub('sharedXB', 'dup');
    const heads = agentRunHeads([a, b]);
    expect(heads.get(a.seq)?.discriminator).toBe('sharedXA');
    expect(heads.get(b.seq)?.discriminator).toBe('sharedXB');
  });

  it('discriminates two ANONYMOUS runs, which have no other cue at all', () => {
    const a = sub('aaaaaa111');
    const b = sub('bbbbbb222');
    const heads = agentRunHeads([a, b]);
    expect(heads.get(a.seq)).toEqual({ agentId: 'aaaaaa111', discriminator: 'aaaaaa' });
    expect(heads.get(b.seq)).toEqual({ agentId: 'bbbbbb222', discriminator: 'bbbbbb' });
  });

  it('keeps a named run and an anonymous one in separate buckets', () => {
    // The unnamed bucket is keyed on '' — a named run must not be dragged into
    // it and given a suffix it does not need.
    const named = sub('aaaaaa111', 'Explore');
    const anon = sub('bbbbbb222');
    const heads = agentRunHeads([named, anon]);
    expect(heads.get(named.seq)?.discriminator).toBeUndefined();
    expect(heads.get(anon.seq)?.discriminator).toBeUndefined();
  });

  it('keeps the FIRST name an agent gives, if it ever gives two', () => {
    // Measured: no agentId in the corpus carries two different names, so this
    // is unreachable today. Pinned anyway because "first wins" and "last wins"
    // are indistinguishable until it happens, and then the caption would
    // change under the reader's eye as more of a run arrived — a caption that
    // rewrites itself is worse than either answer.
    const a = sub('idA', 'Explore');
    const b = sub('idA', 'Plan');
    expect(agentRunHeads([a, b]).get(a.seq)?.name).toBe('Explore');
  });

  describe('a caption is a fact about the SESSION, not about the window (#788 review)', () => {
    it('keeps a name that has scrolled out of the visible list', () => {
      // `attributionAgent` rides on assistant lines and the buffer evicts from
      // the front at 1,000 blocks. Resolved from the window, a long session's
      // run degrades from `Subagent · digger` to a bare `Subagent` the moment
      // the named block falls off — silently, and only for the sessions that
      // ran enough agents to need the caption most.
      const named = sub('idA', 'digger');
      const stillVisible = sub('idA');
      const heads = agentRunHeads([stillVisible], [named, stillVisible]);
      expect(heads.get(stillVisible.seq)?.name).toBe('digger');
    });

    it('keeps a name the current verbosity is hiding', () => {
      // Same defect, no eviction required: a name carried on a `thinking` block
      // is hidden by `normal` and shown by `firehose`, so one run would read
      // two different ways depending on a chip.
      const hidden = block({ kind: 'thinking', sidechain: true, agentId: 'idA', agentName: 'digger' });
      const shown = sub('idA');
      expect(agentRunHeads([shown], [hidden, shown]).get(shown.seq)?.name).toBe('digger');
    });

    it('discriminates against a twin that is NOT on screen', () => {
      // The other half. Computed from the window, a run the user has already
      // read as `Subagent · digger` sprouts a fragment when its twin scrolls
      // into view and drops it again when the twin is evicted — the caption
      // rewriting itself under the reader, and re-introducing the exact
      // ambiguity this item removes.
      const a = sub('aaaaaa11', 'digger');
      const offScreen = sub('bbbbbb22', 'digger');
      expect(agentRunHeads([a], [a, offScreen]).get(a.seq)?.discriminator).toBe('aaaaaa');
    });

    it('defaults the second list to the first, for a caller that has one', () => {
      const a = sub('idA', 'Explore');
      expect(agentRunHeads([a]).get(a.seq)?.name).toBe('Explore');
    });

    it('a NON-sidechain block cannot contribute a name, even carrying both fields', () => {
      // Widening the two session-scoped passes to `all` widened what they can
      // see, so both still have to check `sidechain` — the main conversation is
      // now in the list they walk. A round-2 mutant that dropped the check
      // survived until this existed.
      const impostor = block({ agentId: 'idA', agentName: 'wrong' });
      const real = sub('idA');
      expect(agentRunHeads([real], [impostor, real]).get(real.seq)?.name).toBeUndefined();
    });

    it('a NON-sidechain block cannot force a discriminator onto a real run', () => {
      // The other half: joining the clash bucket would make one genuine agent
      // look like two, appending a fragment that means nothing.
      const impostor = block({ agentId: 'bbbbbb22' });
      const real = sub('aaaaaa11');
      expect(agentRunHeads([real], [impostor, real]).get(real.seq)?.discriminator).toBeUndefined();
    });
  });

  describe('an UNATTRIBUTED sidechain still gets a separator (#788 review)', () => {
    // Before this item a sidechain `user` block at least got a stray
    // "NEW PROMPT" rule. Removing that (correctly) without putting anything in
    // its place would leave an un-attributable subagent with LESS separation
    // than the bug being fixed. Reachable on a resumed stream session, whose
    // replay reads the main transcript only and so has no filename to fall
    // back on.
    const anon = (): FeedBlockDto => block({ sidechain: true });

    it('captions a run that has no agentId at all', () => {
      const main = block();
      const old = anon();
      const heads = agentRunHeads([main, old]);
      expect(heads.get(old.seq)).toEqual({});
      expect(heads.has(main.seq)).toBe(false);
    });

    it('treats consecutive unattributed blocks as ONE run', () => {
      const a = anon();
      const b = anon();
      expect([...agentRunHeads([a, b]).keys()]).toEqual([a.seq]);
    });

    it('separates an unattributed run from an attributed one', () => {
      const anonymous = anon();
      const known = sub('idA', 'Explore');
      const heads = agentRunHeads([anonymous, known]);
      expect([...heads.keys()]).toEqual([anonymous.seq, known.seq]);
      expect(heads.get(anonymous.seq)?.agentId).toBeUndefined();
    });

    it('never gives an unattributed run a discriminator — it has no id to show', () => {
      // The discriminating fixture, not just two anonymous runs: there are also
      // two IDENTIFIED but unnamed agents here, so the shared `''` bucket holds
      // more than one id and the clash branch is live. An implementation that
      // walked into that branch for a run with no id would slice `undefined`.
      const a = anon();
      const main = block();
      const named1 = sub('aaaaaa11');
      const named2 = sub('bbbbbb22');
      const heads = agentRunHeads([a, main, named1, named2]);
      // the clash branch really is live for the identified pair — witness
      expect(heads.get(named1.seq)?.discriminator).toBe('aaaaaa');
      expect(heads.get(named2.seq)?.discriminator).toBe('bbbbbb');
      // ...and the unattributed run comes back with NO keys at all, not with
      // `agentId: undefined` (which `toEqual` would have let through)
      const head = heads.get(a.seq)!;
      expect(Object.keys(head)).toEqual([]);
    });
  });

  it('survives __proto__ as an agent id and as an agent name', () => {
    // Untrusted text from another process reaching a lookup keyed by it. Built
    // as TEXT so the hostile key is a real own property.
    const parsed = JSON.parse(
      '[{"seq":1,"kind":"assistant","sidechain":true,"agentId":"__proto__","agentName":"__proto__"},' +
        '{"seq":2,"kind":"assistant","sidechain":true,"agentId":"other","agentName":"__proto__"}]'
    ) as FeedBlockDto[];
    expect(Object.prototype.hasOwnProperty.call(parsed[0], 'agentId')).toBe(true); // witness
    const heads = agentRunHeads(parsed);
    expect(heads.size).toBe(2);
    // both claim the name `__proto__`, so both are discriminated
    expect(heads.get(1)?.discriminator).toBe('__prot');
    expect(heads.get(2)?.discriminator).toBe('other');
  });

  it('IGNORES an agentId on a block that is not a sidechain', () => {
    // The second half of `agentOriginFor`'s gate, on the other side of the IPC
    // boundary. The caption is indented onto the dashed sidechain spine; above
    // an un-indented main block it reads as a broken layout, not a wrong label.
    const main = block({ agentId: 'idA', agentName: 'Explore' });
    expect(agentRunHeads([main]).size).toBe(0);
  });

  it('a non-sidechain block with an id still ENDS the run it interrupts', () => {
    const a1 = sub('idA', 'Explore');
    const impostor = block({ agentId: 'idA' });
    const a2 = sub('idA');
    const heads = agentRunHeads([a1, impostor, a2]);
    expect([...heads.keys()]).toEqual([a1.seq, a2.seq]);
    expect(heads.has(impostor.seq)).toBe(false);
  });
});
