import { describe, it, expect } from 'vitest';
import {
  attentionPaint,
  rollupLead,
  rollupParts,
  shownStatus,
  tabWordFor,
  waitPaint,
  waitRollup,
  waitState,
  WAIT_TOKEN,
  STATUS_TOKENS,
  finishedCount,
  presentStatus,
  statusVars,
  needCount,
  clampRailWidth,
  railWidthAtPointer,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MIN,
  RAIL_WIDTH_MAX,
  type StatusToken,
} from './rail-view';

describe('presentStatus', () => {
  it('marks exactly the four human-blocking states as needing you', () => {
    const needy = ['needs-input', 'needs-permission', 'done', 'crashed'];
    // 'not-started' (#687) is in the CALM list deliberately: the card is
    // already drawing its own overlay with Try again and Close, and a session
    // that never started has made no demand — putting it in the attention queue
    // and the "N need you" count would be us inventing one.
    const calm = ['starting', 'working', 'idle', 'suspended', 'ended', 'not-started'];
    for (const s of needy) expect(presentStatus(s).needsYou, s).toBe(true);
    for (const s of calm) expect(presentStatus(s).needsYou, s).toBe(false);
  });

  it('spins only while the agent is actually running', () => {
    expect(presentStatus('working').spinner).toBe(true);
    expect(presentStatus('starting').spinner).toBe(true);
    expect(presentStatus('idle').spinner).toBe(false);
    expect(presentStatus('done').spinner).toBe(false);
  });

  it('gives a glyph to every non-spinning state and none to the spinning ones', () => {
    for (const s of [
      'needs-input',
      'needs-permission',
      'done',
      'crashed',
      'idle',
      'suspended',
      'ended',
      'not-started',
    ]) {
      expect(presentStatus(s).glyphKey, s).toBeTruthy();
    }
    expect(presentStatus('working').glyphKey).toBeUndefined();
    expect(presentStatus('starting').glyphKey).toBeUndefined();
  });

  it('folds starting into working, and suspended and not-started into idle', () => {
    expect(presentStatus('starting').token).toBe('working');
    expect(presentStatus('suspended').token).toBe('idle');
    expect(presentStatus('not-started').token).toBe('idle');
    // ...but they keep their own sub-label — "starting" is not "working"
    expect(presentStatus('starting').labelKey).not.toBe(presentStatus('working').labelKey);
    expect(presentStatus('suspended').labelKey).not.toBe(presentStatus('idle').labelKey);
    // and #687's is not "suspended" either, which is the whole point of having
    // it: "suspended" says the session ran and can be resumed, and this one
    // never ran at all
    expect(presentStatus('not-started').labelKey).not.toBe(presentStatus('suspended').labelKey);
    expect(presentStatus('not-started').labelKey).toBe('railStatus.notStarted');
  });

  it('does not answer not-started through the fail-open path (#687)', () => {
    // The trap this closes: 'not-started' folds to the idle ramp, so a
    // MISSING table entry would look identical at every call site that reads
    // `token` — `presentStatus` answers `PRESENTATION.idle` for anything it
    // does not know. The label is the only thing that tells the two apart.
    expect(presentStatus('not-started').labelKey).not.toBe(presentStatus('nonsense').labelKey);
  });

  it('fails open: an unknown or missing status reads as idle, never as an alarm', () => {
    for (const s of [undefined, '', 'compacting', 'who-knows']) {
      const p = presentStatus(s);
      expect(p.needsYou, String(s)).toBe(false);
      expect(p.token, String(s)).toBe('idle');
      expect(p.spinner, String(s)).toBe(false);
    }
  });
});

describe('statusVars', () => {
  it('names the hue and the ink of a ramp position', () => {
    expect(statusVars('crashed')).toEqual({
      hue: 'var(--status-crashed)',
      ink: 'var(--status-crashed-ink)',
    });
  });

  it('never offers the raw hue as a text color', () => {
    // the status pill's bug in one line (#221): the hue is for dots and tints,
    // and the ink is the only one measured against what is behind the text
    for (const s of ['working', 'needs-input', 'needs-permission', 'idle', 'done', 'crashed']) {
      const v = statusVars(s as StatusToken);
      expect(v.ink, s).toMatch(/-ink\)$/);
      expect(v.ink, s).not.toBe(v.hue);
    }
  });

  it('takes whatever presentStatus folded a raw status into', () => {
    expect(statusVars(presentStatus('suspended').token).ink).toBe('var(--status-idle-ink)');
    expect(statusVars(presentStatus('starting').token).ink).toBe('var(--status-working-ink)');
  });
});

describe('needCount (#621)', () => {
  const group = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  it('counts the members with an outstanding demand on them', () => {
    expect(needCount(group, new Set(['a', 'c']))).toBe(2);
  });

  it('is zero for an empty group, and for one with nothing outstanding', () => {
    expect(needCount([], new Set(['a']))).toBe(0);
    expect(needCount(group, new Set())).toBe(0);
  });

  it('counts MEMBERS, not entries — a card elsewhere is not this one’s', () => {
    // the group summary is per-group and the set is workspace-wide, so a needy
    // session in the next group must not inflate this header
    expect(needCount([{ id: 'a' }], new Set(['a', 'zz', 'yy']))).toBe(1);
  });

  it('counts each card once however often it appears in the set', () => {
    // a Set makes this true by construction; asserted so a future "list of
    // events" refactor cannot quietly start double-counting a session that
    // raised two
    expect(needCount([{ id: 'a' }], new Set(['a']))).toBe(1);
  });

  it('is NOT presentStatus — that is the bug it was (#621)', () => {
    // the whole point: a dismissed session still HAS a needy status (the CLI
    // may still be blocked, and the row still says so), and the counter must
    // not report it anyway
    expect(presentStatus('needs-input').needsYou).toBe(true);
    expect(needCount([{ id: 'a' }], new Set())).toBe(0);
  });
});

describe('clampRailWidth', () => {
  it('keeps a sane width untouched', () => {
    expect(clampRailWidth(RAIL_WIDTH_DEFAULT)).toBe(RAIL_WIDTH_DEFAULT);
    expect(clampRailWidth(320)).toBe(320);
  });

  it('never lets a drag hide the rail or eat the grid', () => {
    expect(clampRailWidth(0)).toBe(RAIL_WIDTH_MIN);
    expect(clampRailWidth(-400)).toBe(RAIL_WIDTH_MIN);
    expect(clampRailWidth(9000)).toBe(RAIL_WIDTH_MAX);
  });

  it('rounds to whole pixels and falls back on garbage', () => {
    expect(clampRailWidth(286.6)).toBe(287);
    expect(clampRailWidth(NaN)).toBe(RAIL_WIDTH_DEFAULT);
    expect(clampRailWidth(Infinity)).toBe(RAIL_WIDTH_DEFAULT);
  });
});

// The rail's edge is dragged with a PHYSICAL pointer coordinate but sets a
// LOGICAL inline size, and the two disagree by the width of the window under
// `dir="rtl"` — the same confusion that put the context menu off screen (#642).
describe('railWidthAtPointer', () => {
  const VW = 1008;

  it('is the pointer’s distance from the left edge when the app reads left-to-right', () => {
    expect(railWidthAtPointer(300, VW, 'ltr')).toBe(300);
  });

  it('is the distance from the RIGHT edge when the app reads right-to-left', () => {
    // the rail is on the right under rtl, so a gripper at x=708 is a 300px rail
    expect(railWidthAtPointer(VW - 300, VW, 'rtl')).toBe(300);
  });

  it('the bug it fixes: a physical x would have pinned the rail to its maximum', () => {
    // the gripper of a default-width rail, under rtl, is at 1008 - 286 = 722
    const gripper = VW - RAIL_WIDTH_DEFAULT;
    expect(clampRailWidth(gripper)).toBe(RAIL_WIDTH_MAX); // what it used to do
    expect(railWidthAtPointer(gripper, VW, 'rtl')).toBe(RAIL_WIDTH_DEFAULT);
  });

  it('and the drag runs the right way: further from the inline-start edge is wider', () => {
    const a = railWidthAtPointer(VW - 250, VW, 'rtl');
    const b = railWidthAtPointer(VW - 350, VW, 'rtl');
    expect(b).toBeGreaterThan(a);
  });

  it('still clamps, in either direction', () => {
    for (const direction of ['ltr', 'rtl'] as const) {
      for (const x of [-9999, 0, 1, 500, VW, 9999]) {
        const w = railWidthAtPointer(x, VW, direction);
        expect(w).toBeGreaterThanOrEqual(RAIL_WIDTH_MIN);
        expect(w).toBeLessThanOrEqual(RAIL_WIDTH_MAX);
      }
    }
  });
});

describe("the row's short state word (#877)", () => {
  // ⚠️ EVERY ASSERTION HERE EXISTS BECAUSE CI CAUGHT THE ALTERNATIVE. The row
  // first read `status.${token}`, and `token` is the COLOUR RAMP stem — so
  // three pairs of genuinely different states were given one word each, and a
  // suspended session read "idle". These are the three pairs.
  it('does not confuse a suspended session with an idle one', () => {
    expect(presentStatus('suspended').shortKey).not.toBe(presentStatus('idle').shortKey);
    // …which is exactly what sharing the ramp would have done
    expect(presentStatus('suspended').token).toBe(presentStatus('idle').token);
  });

  it('does not confuse a starting session with a working one', () => {
    expect(presentStatus('starting').shortKey).not.toBe(presentStatus('working').shortKey);
    expect(presentStatus('starting').token).toBe(presentStatus('working').token);
  });

  it('does not confuse a session that never started with a suspended one', () => {
    expect(presentStatus('not-started').shortKey).not.toBe(presentStatus('suspended').shortKey);
    expect(presentStatus('not-started').token).toBe(presentStatus('suspended').token);
  });

  it('speaks the card header pill vocabulary, so one state is one word', () => {
    // `status.*` and not `railStatus.*`: §5.11 says a session's identity renders
    // the same everywhere, and the pill (`SessionGrid`'s `StatusPill`) resolves
    // `status.${status}`. A second namespace here would be a second word for
    // one state.
    for (const s of ['starting', 'working', 'needs-input', 'needs-permission', 'idle', 'done', 'crashed', 'suspended', 'not-started']) {
      expect(presentStatus(s).shortKey, s).toMatch(/^status\./);
    }
  });

  it('gives an unknown status the idle word, never a blank', () => {
    // Same fail-open rule as the rest of this table: our blind spot must not
    // render an empty space where the state goes.
    expect(presentStatus('nonsense').shortKey).toBe(presentStatus('idle').shortKey);
    expect(presentStatus(undefined).shortKey).toBe(presentStatus('idle').shortKey);
  });
});

describe('attentionPaint — the one rule for who is lit (#1137)', () => {
  it('lights a counted session in its own ramp', () => {
    expect(attentionPaint('done', true)).toMatchObject({ lit: true, token: 'waiting', stateInk: true });
    expect(attentionPaint('needs-input', true)).toMatchObject({
      lit: true,
      token: 'needs-input',
      stateInk: true,
    });
  });

  // looking at a finished session takes it off the count and leaves it `done`;
  // it is still WAITING for its next prompt, so its word keeps the gold (#1351)
  it('does not light a finished session nobody is counting, but keeps its word gold', () => {
    expect(attentionPaint('done', false)).toMatchObject({ lit: false, token: 'waiting', stateInk: true });
  });

  // dismissing an ask does not answer it: the word keeps its colour
  it.each(['needs-input', 'needs-permission', 'crashed'])(
    'keeps the state word coloured for a dismissed %s',
    (status) => {
      expect(attentionPaint(status, false)).toMatchObject({ lit: false, token: status, stateInk: true });
    }
  );

  // a returned review is filed on its author, who is usually idle
  it('lights a counted session whose status is calm, as finished work', () => {
    expect(attentionPaint('idle', true)).toMatchObject({ lit: true, token: 'waiting', stateInk: true });
    expect(attentionPaint('working', true).token).toBe('waiting');
  });

  // #1219: finished work nobody has looked at is lit too, in the finished
  // ramp, but it is the OTHER count and says so
  it('lights FINISHED, unseen work, and marks it as not a demand', () => {
    expect(attentionPaint('done', false, true)).toEqual({
      lit: true,
      token: 'waiting',
      stateInk: true,
      finished: true,
    });
    // a demand wins: a card is in one count or the other, never both
    expect(attentionPaint('needs-permission', true, true).finished).toBe(false);
    expect(attentionPaint('done', true).finished).toBe(false);
    expect(attentionPaint('done', false).finished).toBe(false);
  });

  it('fails open on a status it does not know', () => {
    expect(attentionPaint('no-such-status', false)).toMatchObject({
      lit: false,
      token: 'idle',
      stateInk: false,
    });
    expect(attentionPaint(undefined, false).lit).toBe(false);
  });
});

describe('finishedCount — every "N finished" readout (#1219)', () => {
  it('counts the sessions in the finished set, and only those', () => {
    const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(finishedCount(sessions, new Set(['a', 'c', 'elsewhere']))).toBe(2);
    expect(finishedCount(sessions, new Set())).toBe(0);
    expect(finishedCount([], new Set(['a']))).toBe(0);
  });
});

describe('waiting on you — the three states and their words (#1351)', () => {
  it('names the three states, and nothing else waits on you', () => {
    expect(waitState('needs-permission')).toBe('approval');
    expect(waitState('needs-input')).toBe('question');
    expect(waitState('done')).toBe('waiting');
    // idle is a session that has not run a turn yet: calm, not waiting
    for (const s of ['idle', 'working', 'starting', 'crashed', 'suspended', 'ended', 'not-started', 'nonsense', undefined]) {
      expect(waitState(s), String(s)).toBeUndefined();
    }
  });

  it('paints each in its own ramp position, and the finished turn in the gold', () => {
    expect(WAIT_TOKEN).toEqual({ approval: 'needs-permission', question: 'needs-input', waiting: 'waiting' });
    expect(presentStatus('done').token).toBe('waiting');
    expect(STATUS_TOKENS).toContain('waiting');
  });

  it('gives each its word, in the pill vocabulary, and the list its longer one', () => {
    expect(presentStatus('needs-permission').shortKey).toBe('status.needs-permission');
    expect(presentStatus('needs-input').shortKey).toBe('status.needs-input');
    expect(presentStatus('done').shortKey).toBe('status.done');
    expect(presentStatus('done').listKey).toBe('status.doneList');
    expect(presentStatus('idle').listKey).toBeUndefined();
  });

  it('washes every waiting session, counted or not, and nothing calm', () => {
    for (const s of ['needs-permission', 'needs-input', 'done']) {
      expect(waitPaint(s, attentionPaint(s, false)).washed, s).toBe(true);
      expect(waitPaint(s, attentionPaint(s, true)).washed, s).toBe(true);
    }
    for (const s of ['idle', 'working', 'suspended', 'crashed']) {
      expect(waitPaint(s, attentionPaint(s, false)).washed, s).toBe(false);
    }
    // a session lit for something its status does not show is washed in the
    // ramp it is lit in, so a lit row is never the one row left unexplained
    expect(waitPaint('idle', attentionPaint('idle', true))).toEqual({
      state: undefined,
      washed: true,
      token: 'waiting',
    });
    expect(waitPaint('needs-input', attentionPaint('needs-input', false)).token).toBe('needs-input');
  });
});

describe('a held question is shown as one (#1351)', () => {
  it('reads needs-permission as needs-input only when the held request is a question', () => {
    expect(shownStatus('needs-permission', true)).toBe('needs-input');
    expect(shownStatus('needs-permission', false)).toBe('needs-permission');
    // nothing else moves, whatever is held
    for (const s of ['working', 'done', 'idle', 'needs-input', undefined]) {
      expect(shownStatus(s, true), String(s)).toBe(s);
    }
  });
});

describe('a dismissed "waiting" is shown as calm (#1413)', () => {
  it('reads a dismissed done as idle, and nothing else moves', () => {
    expect(shownStatus('done', false, true)).toBe('idle');
    expect(shownStatus('done', false, false)).toBe('done');
    // approval and question are NOT dismissable: they are really blocked
    expect(shownStatus('needs-permission', false, true)).toBe('needs-permission');
    expect(shownStatus('needs-permission', true, true)).toBe('needs-input');
    for (const s of ['working', 'idle', 'needs-input', 'crashed', 'ended', undefined]) {
      expect(shownStatus(s, false, true), String(s)).toBe(s);
    }
  });

  it("a group's roll-up does not count it as waiting", () => {
    const members = [
      { id: 'a', status: 'done' },
      { id: 'b', status: 'done' },
      { id: 'c', status: 'done' },
    ];
    expect(waitRollup(members).waiting).toBe(3);
    const r = waitRollup(members, undefined, undefined, (id) => id === 'b');
    expect(r.waiting).toBe(2);
    expect(rollupParts(r)).toEqual([{ key: 'rail.rollup.waiting', count: 2 }]);
    // the last one: the clause goes, and the group is calm
    const none = waitRollup(members, undefined, undefined, () => true);
    expect(rollupLead(none)).toBeUndefined();
    expect(rollupParts(none)).toEqual([{ key: 'rail.calm' }]);
  });

  it('an approval in the group is not dismissed by the predicate', () => {
    const r = waitRollup([{ id: 'a', status: 'needs-permission' }], undefined, undefined, () => true);
    expect(r.approval).toBe(1);
  });
});

describe("a group's roll-up (#1351, #1196)", () => {
  const of = (...statuses: string[]): Array<{ status: string }> => statuses.map((status) => ({ status }));

  it('counts each state, and working only for what is not waiting', () => {
    expect(waitRollup(of('needs-permission', 'done', 'done', 'working', 'starting', 'idle'))).toEqual({
      approval: 1,
      question: 0,
      crashed: 0,
      waiting: 2,
      working: 2,
    });
    expect(waitRollup([])).toEqual({ approval: 0, question: 0, crashed: 0, waiting: 0, working: 0 });
  });

  it('a crashed session is its own part — never "waiting", never "calm", counted or not', () => {
    const members = [{ id: 'x', status: 'crashed' }, { id: 'y', status: 'done' }];
    const r = waitRollup(members, (id) => id === 'x');
    expect(r).toMatchObject({ crashed: 1, waiting: 1 });
    expect(rollupLead(r)).toBe('crashed');
    expect(rollupParts(r)).toEqual([
      { key: 'rail.rollup.crashed', count: 1 },
      { key: 'rail.rollup.waiting', count: 1 },
    ]);
    // an approval or a question still outranks it
    expect(rollupLead(waitRollup(of('crashed', 'needs-input')))).toBe('question');
  });

  it('counts a session the count lit for something else as waiting, so the line matches the washed rows', () => {
    const members = [
      { id: 'a', status: 'idle' },
      { id: 'b', status: 'working' },
      { id: 'c', status: 'needs-input' },
    ];
    const lit = (id: string): boolean => id === 'a' || id === 'b' || id === 'c';
    expect(waitRollup(members, lit)).toEqual({ approval: 0, question: 1, crashed: 0, waiting: 2, working: 0 });
    // and with nothing lit, the states alone
    expect(waitRollup(members, () => false)).toEqual({ approval: 0, question: 1, crashed: 0, waiting: 0, working: 1 });
  });

  it('leads with the most urgent: approval, question, waiting, working', () => {
    expect(rollupLead(waitRollup(of('done', 'needs-input', 'needs-permission')))).toBe('approval');
    expect(rollupLead(waitRollup(of('done', 'needs-input', 'working')))).toBe('question');
    expect(rollupLead(waitRollup(of('done', 'working')))).toBe('waiting');
    expect(rollupLead(waitRollup(of('working', 'idle')))).toBe('working');
    expect(rollupLead(waitRollup(of('idle', 'suspended')))).toBeUndefined();
  });

  it('counts a Direct session holding a question as a question, not an approval', () => {
    const members = [
      { id: 'q', status: 'needs-permission' },
      { id: 'p', status: 'needs-permission' },
    ];
    expect(waitRollup(members, undefined, (id) => id === 'q')).toEqual({
      approval: 1,
      question: 1,
      crashed: 0,
      waiting: 0,
      working: 0,
    });
  });

  it('says each non-zero state, most urgent first, and leaves the zeros out', () => {
    expect(rollupParts(waitRollup(of('done', 'needs-permission', 'working')))).toEqual([
      { key: 'rail.rollup.approval', count: 1 },
      { key: 'rail.rollup.waiting', count: 1 },
    ]);
  });

  it('says "N working" when nothing is waiting, and "calm" only when nothing is happening', () => {
    expect(rollupParts(waitRollup(of('working', 'working', 'idle')))).toEqual([
      { key: 'rail.workingSummary', count: 2 },
    ]);
    expect(rollupParts(waitRollup(of('idle', 'suspended', 'not-started')))).toEqual([{ key: 'rail.calm' }]);
  });
});

describe('a session whose process has ended (#1362)', () => {
  // Main reports 'ended' off `sessions:cards` for a card whose CLI exited and
  // was not called a crash. It used to arrive as the leftover `done`, which
  // read "waiting" everywhere but the card's own header.
  it('is neutral: the idle ramp, no spinner, not a demand, and its own word', () => {
    const p = presentStatus('ended');
    expect(p.token).toBe('idle');
    expect(p.needsYou).toBe(false);
    expect(p.spinner).toBe(false);
    expect(p.shortKey).toBe('status.ended');
    expect(p.labelKey).toBe('railStatus.ended');
    expect(p.listKey).toBeUndefined();
    // not answered through the fail-open path: its word is not "calm"
    expect(p.shortKey).not.toBe(presentStatus('nonsense').shortKey);
    // ...and not the finished turn's
    expect(p.shortKey).not.toBe(presentStatus('done').shortKey);
  });

  it('is not waiting on you, and is never washed — counted, finished or neither', () => {
    expect(waitState('ended')).toBeUndefined();
    for (const [counted, finished] of [
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      const paint = attentionPaint('ended', counted, finished);
      const wait = waitPaint('ended', paint);
      expect(wait.washed, `counted=${counted} finished=${finished}`).toBe(false);
      expect(wait.state).toBeUndefined();
      // a count may still LIGHT it (the bar and the bold stay the count's,
      // #1137), but never in the waiting gold
      expect(paint.token, `counted=${counted} finished=${finished}`).toBe('idle');
      expect(paint.lit).toBe(counted || finished);
    }
    // its word is quiet unless something is counting it
    expect(attentionPaint('ended', false).stateInk).toBe(false);
  });

  it('is never "waiting" in a group roll-up, even lit — and the group around it is calm', () => {
    const members = [
      { id: 'e', status: 'ended' },
      { id: 'i', status: 'idle' },
    ];
    const r = waitRollup(members, (id) => id === 'e');
    expect(r).toEqual({ approval: 0, question: 0, crashed: 0, waiting: 0, working: 0 });
    expect(rollupParts(r)).toEqual([{ key: 'rail.calm' }]);
    // beside a finished turn, only the finished turn is waiting
    expect(waitRollup([{ id: 'e', status: 'ended' }, { id: 'd', status: 'done' }])).toMatchObject({ waiting: 1 });
    // a crash keeps its own part: ended is not a crash, and a crash is not ended
    expect(waitRollup([{ id: 'c', status: 'crashed' }, { id: 'e', status: 'ended' }])).toMatchObject({
      crashed: 1,
      waiting: 0,
    });
  });

  it('a finished turn still reads waiting, exactly as #1351 built it', () => {
    expect(presentStatus('done').token).toBe('waiting');
    expect(waitState('done')).toBe('waiting');
    expect(waitPaint('done', attentionPaint('done', false, true)).washed).toBe(true);
    expect(attentionPaint('idle', false, true).token).toBe('waiting');
  });
});

describe("the tab's word (#1351, #1362)", () => {
  const word = (status: string | undefined, counted = false) =>
    tabWordFor(status, status === undefined ? undefined : waitPaint(status, attentionPaint(status, counted)));

  it('says the waiting state in its colour', () => {
    expect(word('needs-permission')).toEqual({
      key: 'status.needs-permission',
      state: 'approval',
      ink: 'var(--status-needs-permission-ink)',
    });
    expect(word('needs-input')).toEqual({ key: 'status.needs-input', state: 'question', ink: 'var(--status-needs-input-ink)' });
    expect(word('done')).toEqual({ key: 'status.done', state: 'waiting', ink: 'var(--status-waiting-ink)' });
  });

  it('says "working" quietly while it works', () => {
    expect(word('working')).toEqual({ key: 'status.working', state: 'working' });
    expect(word('starting')).toEqual({ key: 'status.starting', state: 'working' });
  });

  it('says "ended" quietly once its process has gone — never "waiting", lit or not', () => {
    expect(word('ended')).toEqual({ key: 'status.ended', state: 'ended' });
    expect(word('ended', true)).toEqual({ key: 'status.ended', state: 'ended' });
  });

  it('says nothing for a calm one, so a calm tab keeps its width', () => {
    for (const s of ['idle', 'suspended', 'not-started', undefined]) expect(word(s), String(s)).toBeUndefined();
  });
});
