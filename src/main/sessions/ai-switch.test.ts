import { describe, expect, it } from 'vitest';
import { arrivalMark, markArrived, pendingArrival, switchCardAi } from './ai-switch';
import { heldNativeIds } from './lineage';
import { MAX_AI_SWITCHES } from '../../shared/ai-switch';
import type { PersistedSession } from '../workspace/store';

const claude = { providerId: 'claude-code', name: 'Claude Code' };
const codex = { providerId: 'codex', name: 'Codex' };

function card(over: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id: 'card-1',
    identity: { title: 't', folder: 'C:/p', providerId: 'claude-code' },
    layoutSlot: 0,
    suspendedAt: '',
    nativeSessionId: 'c-1',
    nativeSessionLineage: ['c-0'],
    usage: { input: 5, output: 6, cacheRead: 0, cacheCreate: 0 },
    model: 'opus',
    ...over,
  };
}

describe('switchCardAi (#1294)', () => {
  it('parks the conversation it leaves, with its numbers, and starts the target fresh', () => {
    const next = switchCardAi(card(), claude, codex, '2026-10-16T10:00:00.000Z', 'm1');
    expect(next.identity.providerId).toBe('codex');
    expect(next.nativeSessionId).toBeUndefined();
    expect(next.nativeSessionLineage).toBeUndefined();
    expect(next.usage).toBeUndefined();
    expect(next.model).toBeUndefined();
    expect(next.conversations).toEqual({
      'claude-code': {
        nativeSessionId: 'c-1',
        nativeSessionLineage: ['c-0'],
        cededNativeIds: undefined,
        usage: { input: 5, output: 6, cacheRead: 0, cacheCreate: 0 },
        model: 'opus',
        cliCost: undefined,
        parkedAt: '2026-10-16T10:00:00.000Z',
      },
    });
    expect(next.aiSwitches).toEqual([
      { kind: 'ai-switch', id: 'm1', from: claude, to: codex, at: '2026-10-16T10:00:00.000Z', briefed: false },
    ]);
  });

  it('switching back puts the parked conversation back EXACTLY — head, lineage, numbers', () => {
    const away = switchCardAi(card(), claude, codex, 'a', 'm1');
    const onCodex = { ...away, nativeSessionId: 'x-1' };
    const back = switchCardAi(onCodex, codex, claude, 'b', 'm2');
    expect(back.identity.providerId).toBe('claude-code');
    expect(back.nativeSessionId).toBe('c-1');
    expect(back.nativeSessionLineage).toEqual(['c-0']);
    expect(back.usage).toEqual({ input: 5, output: 6, cacheRead: 0, cacheCreate: 0 });
    expect(back.model).toBe('opus');
    // and Codex's is parked in its turn
    expect(Object.keys(back.conversations ?? {})).toEqual(['codex']);
    expect(back.conversations?.codex.nativeSessionId).toBe('x-1');
    expect(back.aiSwitches?.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('a card with no conversation on the AI it leaves parks nothing — a switch back starts fresh', () => {
    const next = switchCardAi(card({ nativeSessionId: undefined, nativeSessionLineage: undefined }), claude, codex, 'a', 'm1');
    expect(next.conversations).toBeUndefined();
  });

  it('a head-less chain is still that AI’s, and is parked rather than lost', () => {
    const next = switchCardAi(card({ nativeSessionId: undefined, nativeSessionLineage: ['c-0', 'c-00'] }), claude, codex, 'a', 'm1');
    expect(next.conversations?.['claude-code']).toMatchObject({
      nativeSessionId: 'c-0',
      nativeSessionLineage: ['c-00'],
    });
  });

  it('ceded ids with nothing to park them with stay on the card — the #539 hold is not loosened', () => {
    const next = switchCardAi(
      card({ nativeSessionId: undefined, nativeSessionLineage: undefined, cededNativeIds: ['given-away'] }),
      claude,
      codex,
      'a',
      'm1'
    );
    expect(next.conversations).toBeUndefined();
    expect(next.cededNativeIds).toEqual(['given-away']);
    expect(heldNativeIds(next)).toContain('given-away');
  });

  it('keeps every OTHER parked conversation where it was', () => {
    const gemini = { providerId: 'gemini', name: 'Gemini' };
    const c = card({ conversations: { gemini: { nativeSessionId: 'g-1', parkedAt: 'z' } } });
    const next = switchCardAi(c, claude, codex, 'a', 'm1');
    expect(next.conversations?.gemini).toEqual({ nativeSessionId: 'g-1', parkedAt: 'z' });
    // …and switching TO it un-parks only that one
    const toGemini = switchCardAi({ ...next, nativeSessionId: 'x-1' }, codex, gemini, 'b', 'm2');
    expect(toGemini.nativeSessionId).toBe('g-1');
    expect(Object.keys(toGemini.conversations ?? {}).sort()).toEqual(['claude-code', 'codex']);
  });

  it('never mutates the card it was given', () => {
    const c = card();
    const before = JSON.stringify(c);
    switchCardAi(c, claude, codex, 'a', 'm1');
    expect(JSON.stringify(c)).toBe(before);
  });

  it('keeps the newest marks, bounded', () => {
    let c = card();
    for (let i = 0; i < MAX_AI_SWITCHES + 5; i++) {
      const [from, to] = i % 2 === 0 ? [claude, codex] : [codex, claude];
      c = switchCardAi(c, from, to, String(i), `m${i}`);
    }
    expect(c.aiSwitches).toHaveLength(MAX_AI_SWITCHES);
    expect(c.aiSwitches?.[MAX_AI_SWITCHES - 1].id).toBe(`m${MAX_AI_SWITCHES + 4}`);
  });

  it('the parked conversations count as HELD, so no other card can adopt them', () => {
    const next = switchCardAi(card(), claude, codex, 'a', 'm1');
    expect(heldNativeIds({ ...next, nativeSessionId: 'x-1' }).sort()).toEqual(['c-0', 'c-1', 'x-1']);
  });
});

describe('the divider and the first start (#1294)', () => {
  const away = switchCardAi(card(), claude, codex, '2026-10-16T10:00:00.000Z', 'm1');
  const back = switchCardAi({ ...away, nativeSessionId: 'x-1' }, codex, claude, '2026-10-16T11:00:00.000Z', 'm2');

  it('the divider is the latest switch INTO the AI the card is on', () => {
    expect(arrivalMark(away)?.id).toBe('m1');
    expect(arrivalMark(back)?.id).toBe('m2');
    expect(arrivalMark(card())).toBeUndefined();
  });

  it('only the newest switch is pending, and only until the first start on it', () => {
    expect(pendingArrival(back)?.id).toBe('m2');
    const arrived = { ...back, aiSwitches: markArrived(back.aiSwitches, 'm2', 'now') };
    expect(pendingArrival(arrived)).toBeUndefined();
    // a card no longer on the AI it switched to has nothing pending
    expect(pendingArrival({ ...back, identity: { ...back.identity, providerId: 'codex' } })).toBeUndefined();
  });

  it('markArrived records a briefing only when it is given one', () => {
    const plain = markArrived(back.aiSwitches, 'm2', 'now');
    expect(plain?.[1]).toMatchObject({ arrivedAt: 'now', briefed: false });
    const briefed = markArrived(back.aiSwitches, 'm2', 'now', { turnsSummarised: 4 });
    expect(briefed?.[1]).toMatchObject({ briefed: true, turnsSummarised: 4 });
    expect(briefed?.[0]).toEqual(back.aiSwitches?.[0]);
  });
});
