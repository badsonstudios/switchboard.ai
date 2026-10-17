import { describe, expect, it } from 'vitest';
import { afterSwitchAiAnswer, aiMenuRows, briefingRefOf, dividerCopy, earlierTurnsCopy, type AiItemLike } from './ai-switch-view';
import enJson from '../../../shared/i18n/locales/en.json';

const claude: AiItemLike = {
  kind: 'catalog',
  entry: { id: 'claude-code', name: 'Claude Code', icon: 'claude-code.svg' },
  providerId: 'claude-code',
  registered: true,
  detection: { installed: true, login: 'logged-in', account: 'dan@example.com', plan: 'max' },
};
const codex: AiItemLike = {
  kind: 'catalog',
  entry: { id: 'codex-acp', name: 'Codex', icon: 'codex-acp.svg' },
  providerId: 'codex',
  registered: true,
  detection: { installed: true, login: 'logged-out' },
};
const gemini: AiItemLike = {
  kind: 'catalog',
  entry: { id: 'gemini', name: 'Gemini CLI', icon: 'gemini.svg' },
  registered: false,
  detection: { installed: false, login: 'unknown' },
};

describe('aiMenuRows (#1294, screen 2)', () => {
  it('lists every AI: the current one marked, the live ones first, the missing ones dimmed', () => {
    const rows = aiMenuRows([gemini, claude, codex], 'claude-code', 'Claude Code');
    expect(rows.map((r) => [r.name, r.current, r.selectable, r.missing])).toEqual([
      ['Claude Code', true, true, false],
      ['Codex', false, true, false],
      ['Gemini CLI', false, false, true],
    ]);
    expect(rows[0].icon).toBe('ai-icons/claude-code.svg');
    // a missing one is never something a pick could switch to
    expect(rows[2].providerId).toBeUndefined();
  });

  it('says each AI’s login state and account, honestly', () => {
    const rows = aiMenuRows([claude, codex, gemini], 'claude-code', '');
    expect(rows.map((r) => r.sub)).toEqual([
      { key: 'aiSwitch.loggedInAsPlan', vars: { account: 'dan@example.com', plan: 'max' } },
      { key: 'aiSwitch.loggedOut' },
      { key: 'aiSwitch.notInstalled' },
    ]);
    const unknown = aiMenuRows([{ ...codex, detection: undefined }], 'x', 'X');
    expect(unknown.find((r) => r.name === 'Codex')?.sub).toEqual({ key: 'aiSwitch.loginUnknown' });
  });

  it('a registered AI stays selectable whatever the probe said — and says what it found', () => {
    const unsure = aiMenuRows([{ ...codex, detection: { installed: 'unknown', login: 'unknown' } }], 'claude-code', 'C');
    expect(unsure.find((r) => r.name === 'Codex')).toMatchObject({ selectable: true, sub: { key: 'aiSwitch.loginUnknown' } });
    const notFound = aiMenuRows([{ ...codex, detection: { installed: false, login: 'unknown' } }], 'claude-code', 'C');
    expect(notFound.find((r) => r.name === 'Codex')).toMatchObject({ selectable: true, missing: false, sub: { key: 'aiSwitch.notFound' } });
  });

  it('a card always shows the AI it is on, even one the catalog does not list', () => {
    const rows = aiMenuRows([codex], 'fake-acp', 'Fake ACP');
    expect(rows[0]).toMatchObject({ providerId: 'fake-acp', name: 'Fake ACP', current: true });
    expect(aiMenuRows([], 'claude-code', 'Claude Code')).toHaveLength(1);
  });
});

describe('the divider (§5.5 honesty rule)', () => {
  const mark = {
    kind: 'ai-switch' as const,
    id: 'm',
    from: { providerId: 'claude-code', name: 'Claude Code' },
    to: { providerId: 'codex', name: 'Codex' },
    at: '2026-10-16T14:41:00.000Z',
    briefed: false,
  };
  const now = Date.parse('2026-10-16T15:00:00.000Z');

  it('says the two AIs and when — and claims no briefing it does not record', () => {
    const c = dividerCopy(mark, now, 'en-US');
    expect(c.key).toBe('aiSwitch.divider');
    expect(c.vars).toMatchObject({ from: 'Claude Code', to: 'Codex' });
  });

  it('names the summary only when one was handed, and the count only when it was counted', () => {
    expect(dividerCopy({ ...mark, briefed: true }, now).key).toBe('aiSwitch.dividerBriefed');
    expect(dividerCopy({ ...mark, briefed: true, turnsSummarised: 14 }, now)).toMatchObject({
      key: 'aiSwitch.dividerBriefedTurns',
      vars: { turns: 14 },
    });
    // a turn count with no briefing is not a briefing
    expect(dividerCopy({ ...mark, turnsSummarised: 14 }, now).key).toBe('aiSwitch.divider');
  });

  it('no switch string calls a first switch a resume', () => {
    const strings = (enJson as unknown as { aiSwitch: Record<string, string> }).aiSwitch;
    // "resumes" is said once, and only of coming BACK to an AI — and since
    // #1295 the sentence says what a first switch DOES hand over (the mockup's)
    expect(strings.explain).toBe(
      'Switching hands this card to another AI with a summary of this conversation. Coming back resumes where that AI left off.'
    );
    for (const [k, v] of Object.entries(strings)) {
      if (k === 'explain') continue;
      expect(v.toLowerCase(), k).not.toMatch(/resum/);
    }
  });

  // ── #1295: what the arrival WAS, said only as the mark records it ─────────
  const arrived = { ...mark, arrivedAt: '2026-10-16T14:41:05.000Z' };

  it('the three arrived states — briefed, picked up again, fresh — and the failure', () => {
    expect(dividerCopy({ ...arrived, briefed: true, turnsSummarised: 3 }, now).key).toBe(
      'aiSwitch.dividerBriefedTurns'
    );
    expect(dividerCopy({ ...arrived, resumed: true }, now).key).toBe('aiSwitch.dividerResumed');
    expect(dividerCopy({ ...arrived, startedFresh: true }, now).key).toBe('aiSwitch.dividerFresh');
    // a mark from before #1295 recorded no outcome: it claims nothing (review finding)
    expect(dividerCopy(arrived, now).key).toBe('aiSwitch.divider');
    expect(dividerCopy({ ...arrived, briefed: true, turnsSummarised: 9, summaryPartial: true }, now).key).toBe(
      'aiSwitch.dividerBriefedLastTurns'
    );
    expect(dividerCopy({ ...arrived, briefingFailed: true }, now).key).toBe('aiSwitch.dividerBriefingFailed');
    // not started on yet: nothing is claimed either way
    expect(dividerCopy({ ...mark, resumed: undefined }, now).key).toBe('aiSwitch.divider');
  });

  it('the strings say exactly that', () => {
    const s = (enJson as unknown as { aiSwitch: Record<string, string> }).aiSwitch;
    expect(s.dividerFresh).toBe('{from} → {to} · {time} · started fresh, no summary');
    expect(s.dividerBriefingFailed).toBe('{from} → {to} · {time} · could not brief {to}; it started without context');
    expect(s.seeBriefing).toBe('see what it was told');
  });

  it('"see what it was told" only for a briefing that was sent AND kept', () => {
    expect(briefingRefOf({ ...arrived, briefed: true, briefingRef: 'c/m' })).toBe('c/m');
    expect(briefingRefOf({ ...arrived, briefed: true })).toBeUndefined();
    // a ref on a mark that does not record a briefing is never offered
    expect(briefingRefOf({ ...arrived, briefed: false, briefingRef: 'c/m' })).toBeUndefined();
  });

  it('the faint earlier-turns line: only above a briefing with turns, naming the other AI', () => {
    expect(earlierTurnsCopy({ ...arrived, briefed: true, turnsSummarised: 4 })).toEqual({
      key: 'aiSwitch.earlierTurns',
      vars: { turns: 4, from: 'Claude Code' },
    });
    expect(earlierTurnsCopy({ ...arrived, briefed: true, turnsSummarised: 0 })).toBeUndefined();
    // a partial summary does not count what it did not read
    expect(earlierTurnsCopy({ ...arrived, briefed: true, turnsSummarised: 4, summaryPartial: true })).toEqual({
      key: 'aiSwitch.earlierTurnsMany',
      vars: { from: 'Claude Code' },
    });
    expect(earlierTurnsCopy({ ...arrived, resumed: true, turnsSummarised: 4 })).toBeUndefined();
  });
});

describe('afterSwitchAiAnswer', () => {
  it('asks only a request that did not carry the yes', () => {
    expect(afterSwitchAiAnswer({ ok: false, reason: 'busy', busy: 'working' }, false)).toEqual({
      kind: 'ask',
      busy: 'working',
    });
    expect(afterSwitchAiAnswer({ ok: false, reason: 'busy', busy: 'working' }, true).kind).toBe('notice');
  });
  it('re-arms on a change, closes on none, and says why on a refusal', () => {
    expect(afterSwitchAiAnswer({ ok: true, changed: true }, false)).toEqual({ kind: 'rearm' });
    expect(afterSwitchAiAnswer({ ok: true, changed: false }, false)).toEqual({ kind: 'close' });
    expect(afterSwitchAiAnswer({ ok: false, reason: 'unavailable' }, false)).toEqual({
      kind: 'notice',
      key: 'aiSwitch.refusedUnavailable',
    });
    expect(afterSwitchAiAnswer(null, false)).toEqual({ kind: 'notice', key: 'aiSwitch.refusedFailed' });
  });
});
