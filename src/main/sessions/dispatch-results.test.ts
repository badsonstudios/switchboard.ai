import { describe, it, expect, vi } from 'vitest';
import { DispatchResults, finalReport, MAX_HELD_RESULTS } from './dispatch-results';
import { REPORT_CHAR_CAP } from '../../shared/dispatch-result';
import { SIBLING_MESSAGE_CHAR_CAP, hasUnsafeControl } from '../../shared/sibling-message';
import { TRUNCATION_MARKER_LEN } from './context-package';
import type { DispatchResultDto } from '../../shared/dispatch-result';
import type { FeedBlock } from '../feed/blocks';
import type { Logger } from '../log/logger';
import type { QueryResult } from './queries';
import type { DeliveryReceipt } from './delivery';

const log: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

let seq = 0;
const block = (kind: FeedBlock['kind'], text?: string): FeedBlock => ({
  seq: seq++,
  kind,
  sidechain: false,
  ...(text === undefined ? {} : { text }),
});

/** the two-turn shape every probe run produced: preamble, tool call, report */
const realShape = (report: string): FeedBlock[] => [
  block('user', 'the briefing'),
  block('assistant', "The working tree matches the diff. Here's the review."),
  block('tool'),
  block('assistant', report),
];

const held = (
  over: Partial<{
    receipt: QueryResult<DeliveryReceipt>;
    blocks: readonly FeedBlock[];
  }> = {}
): {
  results: DispatchResults;
  raised: Array<{ author: string; dto: DispatchResultDto }>;
  sends: Array<{ from: string; to: string; text: string }>;
} => {
  const raised: Array<{ author: string; dto: DispatchResultDto }> = [];
  const sends: Array<{ from: string; to: string; text: string }> = [];
  const results = new DispatchResults({
    blocks: () => over.blocks ?? realShape('**Summary:** it is wrong.\n\n- one\n- two'),
    raise: (author, dto) => raised.push({ author, dto }),
    send: (from, to, text) => {
      sends.push({ from, to, text });
      return Promise.resolve(
        over.receipt ?? {
          ok: true,
          value: {
            session: { id: to, name: 'Alpha' },
            outcome: 'held',
            shown: true,
          } as unknown as DeliveryReceipt,
        }
      );
    },
    log,
  });
  return { results, raised, sends };
};

const about = { reviewerName: 'Review of Alpha', templateName: 'Code Reviewer' };

describe('finalReport — the extraction the probe chose (P2-E13-05)', () => {
  it('takes the LAST assistant turn, not the throat-clearing one before the tool call', () => {
    const r = finalReport(realShape('the findings'));
    expect(r.text).toBe('the findings');
  });

  // `assistantIntents` emits one block per content item, so a final turn written
  // as two text items is two blocks. Taking only the last would cut the report in
  // half at a boundary nothing about the text reveals.
  it('takes the whole contiguous RUN of assistant blocks', () => {
    const r = finalReport([block('tool'), block('assistant', 'first half'), block('assistant', 'second half')]);
    expect(r.text).toBe('first half\n\nsecond half');
  });

  it('treats thinking as transparent — it neither ends the run nor joins it', () => {
    const r = finalReport([
      block('tool'),
      block('thinking', 'let me see'),
      block('assistant', 'the findings'),
      block('thinking', 'trailing'),
    ]);
    expect(r.text).toBe('the findings');
  });

  it.each(['tool', 'user', 'todos', 'notice'] as const)('a %s block ENDS the run', (kind) => {
    const r = finalReport([block('assistant', 'older'), block(kind), block('assistant', 'newest')]);
    expect(r.text).toBe('newest');
  });

  it('is empty when the session left no prose at all', () => {
    expect(finalReport([block('user', 'go'), block('tool')]).text).toBe('');
    expect(finalReport([]).text).toBe('');
  });

  it('is empty when the trailing assistant block is whitespace', () => {
    expect(finalReport([block('tool'), block('assistant', '   \n  ')]).text).toBe('');
  });

  // CUT FROM THE HEAD, the opposite of `sessionOutput`: a review leads with its
  // summary, and a reader handed the tail gets the floating-point footnote.
  it('caps from the START and says so in-band', () => {
    const long = 'HEAD' + 'x'.repeat(REPORT_CHAR_CAP * 2) + 'TAIL';
    const r = finalReport([block('assistant', long)]);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('HEAD')).toBe(true);
    expect(r.text.endsWith('…[truncated]')).toBe(true);
    expect(r.text).not.toContain('TAIL');
  });

  // ⚠️ THE ASSERTION THE FIRST CUT WAS MISSING, and the blocker it let through.
  // `capText` slices to its limit and THEN appends ` …[truncated]`, so a report
  // cut at `REPORT_CHAR_CAP` came out 13 characters over it — and `delivery.ts`
  // refuses an over-cap message rather than trimming it, so every long review
  // offered a button that could only ever answer "shorten it and send again"
  // about text the user had not written. The old test checked the marker and the
  // head and never the length, which is exactly how it survived.
  it('caps to a length `delivery.ts` will actually ACCEPT, marker included', () => {
    const r = finalReport([block('assistant', 'z'.repeat(REPORT_CHAR_CAP * 2))]);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(SIBLING_MESSAGE_CHAR_CAP);
  });

  it('leaves a report that fits exactly alone', () => {
    const exact = 'q'.repeat(REPORT_CHAR_CAP - TRUNCATION_MARKER_LEN);
    const r = finalReport([block('assistant', exact)]);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(exact);
  });

  // `delivery.ts` REFUSES a message carrying one, and a report has no sender to
  // be told "send plain text" — so the strip happens here, where the bytes are
  // built, exactly as `stripUnsafeControls` says it should for a context drop.
  it('strips control characters rather than producing an unsendable report', () => {
    const esc = String.fromCodePoint(0x1b);
    const bidi = String.fromCodePoint(0x202e);
    const r = finalReport([block('assistant', `bug at ${esc}[31mline 3${bidi} — fix it`)]);
    expect(hasUnsafeControl(r.text)).toBe(false);
    expect(r.text).toContain('line 3');
  });

  // A subagent's closing summary is not the reviewer reporting to the author —
  // the misattribution `promptText` filters for the same reason.
  it('skips sidechain blocks rather than injecting a subagent’s summary', () => {
    const sub = { ...block('assistant', 'the subagent signing off'), sidechain: true };
    const r = finalReport([block('tool'), block('assistant', 'the review'), sub]);
    expect(r.text).toBe('the review');
  });

  it('headlines the first line, stripped of markdown decoration', () => {
    const r = finalReport([block('assistant', '## Findings\n\n**Summary:** `total()` is wrong.\n\n- one')]);
    expect(r.headline).toBe('Findings');
  });

  it('skips blank lines to find the headline', () => {
    const r = finalReport([block('assistant', '\n\n  \n**This** change does not work.\nmore')]);
    expect(r.headline).toBe('This change does not work.');
  });

  it('caps a runaway first line rather than putting a paragraph on a row', () => {
    const r = finalReport([block('assistant', 'y'.repeat(900))]);
    expect(r.headline!.length).toBeLessThan(200);
    expect(r.headline!.endsWith('…[truncated]')).toBe(true);
  });
});

describe('DispatchResults — the round-trip (P2-E13-05)', () => {
  it('raises the event on the AUTHOR when the dispatched session finishes', () => {
    const { results, raised } = held();
    results.dispatched('reviewer', 'author', about);
    results.completed('reviewer', 'done');
    expect(raised).toHaveLength(1);
    expect(raised[0].author).toBe('author');
    expect(raised[0].dto).toMatchObject({
      reviewer: 'reviewer',
      templateName: 'Code Reviewer',
      reviewerName: 'Review of Alpha',
      outcome: 'reported',
      truncated: false,
    });
    expect(raised[0].dto.chars).toBeGreaterThan(0);
  });

  it('raises nothing for a session nobody dispatched', () => {
    const { results, raised } = held();
    results.completed('some-other-session', 'done');
    expect(raised).toEqual([]);
  });

  // `done` is a TURN ending. A user who opens the reviewer and types at it
  // produces another one, and a fresh "your review is ready" on every turn of a
  // card they are working in is the failure this guards.
  it('is SINGLE USE — a second completion raises nothing', () => {
    const { results, raised } = held();
    results.dispatched('reviewer', 'author', about);
    results.completed('reviewer', 'done');
    results.completed('reviewer', 'done');
    results.completed('reviewer', 'ended');
    expect(raised).toHaveLength(1);
  });

  it('reports `silent` — with no report to inject — when nothing was said', () => {
    const { results, raised } = held({ blocks: [block('user', 'go'), block('tool')] });
    results.dispatched('reviewer', 'author', about);
    results.completed('reviewer', 'done');
    expect(raised[0].dto.outcome).toBe('silent');
    expect(raised[0].dto.chars).toBe(0);
    expect(raised[0].dto.headline).toBeUndefined();
  });

  // The third done-when: a session that crashes or is closed before finishing
  // reaches the author as SOMETHING rather than as silence.
  it('reports `ended` when the session stopped — and still carries what it wrote', () => {
    const { results, raised } = held();
    results.dispatched('reviewer', 'author', about);
    results.completed('reviewer', 'ended');
    expect(raised[0].dto.outcome).toBe('ended');
    expect(raised[0].dto.chars).toBeGreaterThan(0);
  });

  it('reports `ended` with nothing when the session died before saying anything', () => {
    const { results, raised } = held({ blocks: [] });
    results.dispatched('reviewer', 'author', about);
    results.completed('reviewer', 'ended');
    expect(raised[0].dto).toMatchObject({ outcome: 'ended', chars: 0 });
  });

  // P4: our bookkeeping must not be able to cost a session anything.
  it('a Feed that throws produces a `silent` result rather than no result', () => {
    const raised: Array<{ author: string; dto: DispatchResultDto }> = [];
    const results = new DispatchResults({
      blocks: () => {
        throw new Error('feed is gone');
      },
      raise: (author, dto) => raised.push({ author, dto }),
      send: () => Promise.resolve({ ok: false, reason: 'unused' }),
      log,
    });
    results.dispatched('reviewer', 'author', about);
    expect(() => results.completed('reviewer', 'done')).not.toThrow();
    expect(raised[0].dto.outcome).toBe('silent');
  });

  it('a raise that throws does not escape the status fan-out', () => {
    const results = new DispatchResults({
      blocks: () => realShape('findings'),
      raise: () => {
        throw new Error('feed listener blew up');
      },
      send: () => Promise.resolve({ ok: false, reason: 'unused' }),
      log,
    });
    results.dispatched('reviewer', 'author', about);
    expect(() => results.completed('reviewer', 'done')).not.toThrow();
  });

  it('refuses to link a session to itself, or to a blank id', () => {
    const { results, raised } = held();
    results.dispatched('same', 'same', about);
    results.dispatched('', 'author', about);
    results.dispatched('reviewer', '', about);
    results.completed('same', 'done');
    results.completed('reviewer', 'done');
    expect(raised).toEqual([]);
  });

  it('bounds the links it holds', () => {
    const { results, raised } = held();
    for (let i = 0; i < MAX_HELD_RESULTS + 5; i++) results.dispatched(`r${i}`, 'author', about);
    results.completed('r0', 'done'); // the oldest, evicted
    expect(raised).toEqual([]);
    results.completed(`r${MAX_HELD_RESULTS + 4}`, 'done'); // the newest, kept
    expect(raised).toHaveLength(1);
  });

  describe('inject', () => {
    it('sends the report FROM the reviewer TO the author, through ordinary delivery', async () => {
      const { results, sends } = held();
      results.dispatched('reviewer', 'author', about);
      results.completed('reviewer', 'done');
      const out = await results.inject('reviewer');
      expect(out).toEqual({ ok: true, submitted: false });
      expect(sends).toEqual([
        { from: 'reviewer', to: 'author', text: '**Summary:** it is wrong.\n\n- one\n- two' },
      ]);
    });

    // §5.4: the block waits for a human keypress unless THIS CARD's auto-accept
    // toggle is on, which is `delivery.ts`'s decision and not ours.
    it('reports `submitted` only when delivery actually submitted', async () => {
      const { results } = held({
        receipt: {
          ok: true,
          value: { session: { id: 'author' }, outcome: 'submitted' } as unknown as DeliveryReceipt,
        },
      });
      results.dispatched('reviewer', 'author', about);
      results.completed('reviewer', 'done');
      await expect(results.inject('reviewer')).resolves.toEqual({ ok: true, submitted: true });
    });

    // The used-state has to reach the LIST main pushes, not just the component
    // that clicked. Without this, reopening the drawer — or a popped-out Events
    // window — re-offers a button whose report has already been spent, and it
    // answers "no longer being held": an error for an operation that worked.
    it('MARKS the row delivered once the report has landed, with no button left', async () => {
      const { results, raised } = held();
      results.dispatched('reviewer', 'author', about);
      results.completed('reviewer', 'done');
      await results.inject('reviewer');
      expect(raised).toHaveLength(2);
      // Same author, same reviewer — `EventFeed.dispatchResult` replaces by
      // reviewer, so this UPDATES the row rather than adding a second one.
      expect(raised[1].author).toBe('author');
      expect(raised[1].dto).toMatchObject({
        reviewer: 'reviewer',
        outcome: 'delivered',
        chars: 0,
      });
      // …and the headline survives, because the row still has to say what came back
      expect(raised[1].dto.headline).toBe(raised[0].dto.headline);
    });

    it('does not mark a row delivered when its report was refused', async () => {
      const { results, raised } = held({ receipt: { ok: false, reason: 'that card was closed' } });
      results.dispatched('reviewer', 'author', about);
      results.completed('reviewer', 'done');
      await results.inject('reviewer');
      expect(raised).toHaveLength(1);
      expect(raised[0].dto.outcome).toBe('reported');
    });

    // P4: the delivery HAPPENED. A feed that cannot update its row must not turn
    // a success into a failure.
    it('still reports success when marking the row throws', async () => {
      let first = true;
      const results = new DispatchResults({
        blocks: () => realShape('findings'),
        raise: () => {
          if (first) {
            first = false;
            return;
          }
          throw new Error('feed is gone');
        },
        send: () =>
          Promise.resolve({
            ok: true,
            value: { session: { id: 'author' }, outcome: 'held' } as unknown as DeliveryReceipt,
          }),
        log,
      });
      results.dispatched('reviewer', 'author', about);
      results.completed('reviewer', 'done');
      await expect(results.inject('reviewer')).resolves.toMatchObject({ ok: true });
    });

    // `send` awaits a window ack with an 8 s ceiling. Two Events surfaces can
    // show one row, and the channel guards nothing — so without a reservation in
    // main the report is delivered twice.
    it('is SINGLE-FLIGHT — a second click during the send is refused, not delivered', async () => {
      let release!: (v: QueryResult<DeliveryReceipt>) => void;
      const sends: string[] = [];
      const results = new DispatchResults({
        blocks: () => realShape('findings'),
        raise: () => {},
        send: (from) => {
          sends.push(from);
          return new Promise((r) => (release = r));
        },
        log,
      });
      results.dispatched('reviewer', 'author', about);
      results.completed('reviewer', 'done');
      const first = results.inject('reviewer');
      await expect(results.inject('reviewer')).resolves.toEqual({ ok: false, reasonKey: 'inFlight' });
      release({
        ok: true,
        value: { session: { id: 'author' }, outcome: 'held' } as unknown as DeliveryReceipt,
      });
      await expect(first).resolves.toMatchObject({ ok: true });
      expect(sends).toHaveLength(1);
    });

    it('re-arms after a send that threw, rather than wedging the button', async () => {
      const results = new DispatchResults({
        blocks: () => realShape('findings'),
        raise: () => {},
        send: () => Promise.reject(new Error('the bus fell over')),
        log,
      });
      results.dispatched('reviewer', 'author', about);
      results.completed('reviewer', 'done');
      await expect(results.inject('reviewer')).rejects.toThrow();
      // not stuck on `inFlight`
      await expect(results.inject('reviewer')).rejects.toThrow();
    });

    it('is spent once delivered', async () => {
      const { results, sends } = held();
      results.dispatched('reviewer', 'author', about);
      results.completed('reviewer', 'done');
      await results.inject('reviewer');
      await expect(results.inject('reviewer')).resolves.toEqual({ ok: false, reasonKey: 'gone' });
      expect(sends).toHaveLength(1);
    });

    // The author's card having gone away is `delivery.ts`'s `gone` refusal, and
    // #765's rule is that the sender is TOLD which. It must not eat the report:
    // a first click that landed badly cannot be allowed to lose the finding.
    it('a refusal keeps the report, reason and all', async () => {
      const { results } = held({ receipt: { ok: false, reason: 'that card was closed' } });
      results.dispatched('reviewer', 'author', about);
      results.completed('reviewer', 'done');
      await expect(results.inject('reviewer')).resolves.toEqual({
        ok: false,
        reasonKey: 'undelivered',
        detail: 'that card was closed',
      });
      // still there for a second try
      const second = await results.inject('reviewer');
      expect(second).toMatchObject({ ok: false, reasonKey: 'undelivered' });
    });

    it('refuses a session it is holding nothing for', async () => {
      const { results } = held();
      await expect(results.inject('nobody')).resolves.toMatchObject({ ok: false });
      await expect(results.inject(42)).resolves.toMatchObject({ ok: false });
      await expect(results.inject('')).resolves.toMatchObject({ ok: false });
    });

    it('refuses an empty report rather than handing delivery something it will reject', async () => {
      const { results, sends } = held({ blocks: [] });
      results.dispatched('reviewer', 'author', about);
      results.completed('reviewer', 'done');
      const out = await results.inject('reviewer');
      expect(out).toMatchObject({ ok: false });
      expect(sends).toEqual([]);
    });
  });

  describe('forget', () => {
    it('drops a link when either end goes away', () => {
      const a = held();
      a.results.dispatched('reviewer', 'author', about);
      a.results.forget('reviewer');
      a.results.completed('reviewer', 'done');
      expect(a.raised).toEqual([]);

      const b = held();
      b.results.dispatched('reviewer', 'author', about);
      b.results.forget('author');
      b.results.completed('reviewer', 'done');
      expect(b.raised).toEqual([]);
    });

    // ASYMMETRIC ON PURPOSE. Closing a finished reviewer's card says nothing
    // about the finding, and holding the report here is precisely so it can
    // outlive the session that produced it.
    it('a HELD report survives its reviewer going away', async () => {
      const { results, sends } = held();
      results.dispatched('reviewer', 'author', about);
      results.completed('reviewer', 'done');
      results.forget('reviewer');
      await expect(results.inject('reviewer')).resolves.toMatchObject({ ok: true });
      expect(sends).toHaveLength(1);
    });

    it('a held report does NOT survive its author going away', async () => {
      const { results } = held();
      results.dispatched('reviewer', 'author', about);
      results.completed('reviewer', 'done');
      results.forget('author');
      await expect(results.inject('reviewer')).resolves.toMatchObject({ ok: false });
    });
  });

});

describe('DispatchResults — logging', () => {
  it('records the outcome with both ends, so a missing round-trip is findable', () => {
    const info = vi.fn();
    const results = new DispatchResults({
      blocks: () => realShape('findings'),
      raise: () => {},
      send: () => Promise.resolve({ ok: false, reason: 'unused' }),
      log: { ...log, info },
    });
    results.dispatched('reviewer', 'author', about);
    results.completed('reviewer', 'done');
    expect(info).toHaveBeenCalledWith(
      'dispatch result',
      expect.objectContaining({ sessionId: 'reviewer', author: 'author', outcome: 'reported' })
    );
  });
});
