// The engine's half of the needs-you cue (#1267): the in-front probe, the
// `only` narrowing the one-minute repeat uses, and the `replacesBeep` answer
// the notifier's beep listens for.
import { describe, it, expect } from 'vitest';
import { RuleActionRegistry, RulesEngine, RuleActionContext } from './rules-engine';
import {
  ACTION_NEEDS_YOU_SOUND,
  ACTION_SOUND,
  ACTION_WEBHOOK,
  WindowVisibility,
  defaultRules,
} from './rules';
import type { FeedEvent } from './feed';

const LIVE = 'live-1';
const CARD = 'card-a';
const ev = (kind: FeedEvent['kind'] = 'needs-permission'): FeedEvent => ({
  id: 1,
  sessionId: LIVE,
  kind,
  at: '2026-10-18T00:00:00.000Z',
});

function harness(over: { inFront?: (cardId: string | null) => boolean; webhook?: boolean } = {}) {
  const ran: Array<{ type: string; ctx: RuleActionContext }> = [];
  const registry = new RuleActionRegistry();
  for (const type of [ACTION_NEEDS_YOU_SOUND, ACTION_SOUND, ACTION_WEBHOOK])
    registry.register(type, (_a, ctx) => void ran.push({ type, ctx }));
  const vis = { current: 'focused' as WindowVisibility };
  const engine = new RulesEngine({
    getRules: () => [],
    getDefaultRules: () => defaultRules({ webhook: over.webhook === true }),
    cardIdFor: (id) => (id === LIVE ? CARD : null),
    getVisibility: () => vis.current,
    ...(over.inFront ? { isInFront: over.inFront } : {}),
    titleFor: () => 'TradingApp',
    bodyFor: (e) => e.kind,
    registry,
  });
  return { engine, ran, vis };
}

describe('RulesEngine and the needs-you cue (#1267)', () => {
  it('rings for a card that is not in front, and says it replaced the beep', () => {
    const h = harness({ inFront: () => false });
    expect(h.engine.fire(ev())).toEqual({ ran: 1, replacesBeep: true });
    expect(h.ran.map((r) => r.type)).toEqual([ACTION_NEEDS_YOU_SOUND]);
  });

  it('stays quiet for the card in front, and the beep is left alone', () => {
    const h = harness({ inFront: (c) => c === CARD });
    expect(h.engine.fire(ev())).toEqual({ ran: 0, replacesBeep: false });
  });

  it('stays quiet while the app is not the focused window', () => {
    const h = harness({ inFront: () => false });
    h.vis.current = 'visible';
    expect(h.engine.fire(ev()).ran).toBe(0);
  });

  it('no probe, or a probe that throws: not in front, so it rings (P6)', () => {
    expect(harness().engine.fire(ev()).ran).toBe(1);
    const throwing = harness({
      inFront: () => {
        throw new Error('boom');
      },
    });
    expect(throwing.engine.fire(ev()).ran).toBe(1);
  });

  it('`only` narrows a run to the named actions, so the reminder does not re-POST', () => {
    const h = harness({ inFront: () => false, webhook: true });
    h.engine.fire(ev(), { only: [ACTION_NEEDS_YOU_SOUND], reason: 'reminder' });
    expect(h.ran.map((r) => r.type)).toEqual([ACTION_NEEDS_YOU_SOUND]);
    expect(h.ran[0].ctx.reason).toBe('reminder');
  });

  it('a webhook-only run does not replace the beep', () => {
    const h = harness({ inFront: () => true, webhook: true });
    expect(h.engine.fire(ev())).toEqual({ ran: 1, replacesBeep: false });
  });

  it('`handle` is `fire` narrowed to a count', () => {
    const h = harness({ inFront: () => false });
    expect(h.engine.handle(ev())).toBe(1);
  });
});
