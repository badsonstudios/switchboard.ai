// @vitest-environment jsdom
// The events panel's update notice (P2-E19-04).
//
// The panel's rows, ordering and a11y are covered by `a11y-surfaces.test.tsx`
// and `feed.spec.ts`; this file is only about the one non-modal surface the
// update feature owns — and about the distinction that makes it honest:
//
//   • **installed** — the post-update handshake. News, dismissible, no action.
//   • **available** — the offer is still standing after the dialog was closed
//     without being answered. That is the item's "the persistent update
//     available affordance remains", and it is the panel's job because a
//     modal that reopens itself is not an affordance, it is a nag.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { EventsPanel } from './EventsPanel';
import type { EventDto } from '../model/types';
import type { HistoryRepairNotice } from '../../../shared/history-repair';
import type { PermissionRequestDto } from '../../../shared/ipc/permissions';
import type { EventsFilter } from '../lib/events-v2';
import { V2 } from './events-panel-test-props';
import type { SuppressedEvent } from '../../../shared/suppressed';
import { buildDigest, DIGEST_ROWS } from '../lib/digest';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const handlers = {
  onUpdateNow: vi.fn(),
  onDismissUpdateNotice: vi.fn(),
};

async function render(
  notice: { kind: 'installed' | 'available'; version: string } | null
): Promise<void> {
  await act(async () => {
    root!.render(
      <EventsPanel
        sessions={[]}
        events={[]}
        queueEvents={[]}
        visited={new Set<number>()}
        onFocus={() => {}}
        onVisit={() => {}}
        queueBinding="Ctrl+Space"
        {...V2}
        updateNotice={notice}
        {...handlers}
      />
    );
  });
}

const notice = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-events-notice]');
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found;
}
async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const h of Object.values(handlers)) h.mockReset();
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await initI18nForTests();
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('the update notice', () => {
  it('shows nothing at all when there is no notice', async () => {
    await render(null);
    expect(notice()).toBeNull();
    // …and the panel still says it is empty, rather than looking occupied
    expect(host.textContent).toContain(en.events.empty);
  });

  it('the post-update handshake names the version and only offers "got it"', async () => {
    await render({ kind: 'installed', version: '0.2.0' });
    expect(notice()?.getAttribute('data-events-notice')).toBe('installed');
    expect(notice()?.textContent).toContain('0.2.0');
    // Nothing to do — the update already happened.
    expect(() => button(en.events.updateNow)).toThrow();
    await click(button(en.events.gotIt));
    expect(handlers.onDismissUpdateNotice).toHaveBeenCalled();
  });

  it('a standing offer keeps a way back INTO the dialog', async () => {
    await render({ kind: 'available', version: '0.2.0' });
    expect(notice()?.getAttribute('data-events-notice')).toBe('available');
    expect(notice()?.textContent).toContain('0.2.0');
    await click(button(en.events.updateNow));
    expect(handlers.onUpdateNow).toHaveBeenCalled();
    expect(handlers.onDismissUpdateNotice).not.toHaveBeenCalled();
  });

  it('the offer can be waved away without answering it', async () => {
    await render({ kind: 'available', version: '0.2.0' });
    await click(button(en.events.notNow));
    expect(handlers.onDismissUpdateNotice).toHaveBeenCalled();
    expect(handlers.onUpdateNow).not.toHaveBeenCalled();
  });

  it('is made of real buttons, like everything else the a11y sweep touched', async () => {
    // The panel's standing rule: a control is a <button>, not a div with a
    // click handler. Both notices, both flavours.
    for (const kind of ['installed', 'available'] as const) {
      await render({ kind, version: '0.2.0' });
      const controls = notice()!.querySelectorAll('button');
      expect(controls.length, kind).toBeGreaterThan(0);
      for (const b of controls) expect(b.textContent?.trim()).toBeTruthy();
    }
  });
});

// #539 — the repair sweep and the duplicate untangle both move a card's
// conversation without being asked. Until this notice they reported that only
// to the log, which makes "my card came back somewhere else" indistinguishable
// from the bug the sweep exists to repair.
describe('the history-repair notice (#539)', () => {
  const onDismiss = vi.fn();
  const repair = (over: Partial<HistoryRepairNotice> = {}): HistoryRepairNotice => ({
    id: 'r1',
    kind: 'adopted',
    cardId: 'card-1',
    cardTitle: 'Switchboard.ai',
    nativeSessionId: 'conv-x',
    ...over,
  });

  async function show(repairs: HistoryRepairNotice[]): Promise<void> {
    await act(async () => {
      root!.render(
        <EventsPanel
          sessions={[]}
          events={[]}
          queueEvents={[]}
          visited={new Set<number>()}
          onFocus={() => {}}
          onVisit={() => {}}
          queueBinding="Ctrl+Space"
          {...V2}
          historyRepairs={repairs}
          onDismissHistoryRepair={onDismiss}
        />
      );
    });
  }

  const rows = (): HTMLElement[] => [
    ...host.querySelectorAll<HTMLElement>('[data-history-repair]'),
  ];

  beforeEach(() => onDismiss.mockReset());

  it('names the card that was reconnected', async () => {
    await show([repair()]);
    expect(host.querySelector('[data-events-notice="history-repair"]')).not.toBeNull();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].getAttribute('data-history-repair')).toBe('adopted');
    expect(rows()[0].textContent).toContain('Switchboard.ai');
  });

  it('names BOTH cards when one gave a conversation up', async () => {
    await show([
      repair({ kind: 'ceded', cardTitle: 'Switchboard.ai-2', keptByTitle: 'Switchboard.ai' }),
    ]);
    expect(rows()[0].getAttribute('data-history-repair')).toBe('ceded');
    expect(rows()[0].textContent).toContain('Switchboard.ai-2');
    expect(rows()[0].textContent).toContain('Switchboard.ai');
  });

  it('announces itself — it is already true when the window mounts', async () => {
    await show([repair()]);
    const live = host.querySelector('[data-events-notice="history-repair"] [role="status"]');
    expect(live).not.toBeNull();
    expect(live!.getAttribute('aria-live')).toBe('polite');
  });

  it('is dismissible, one row at a time', async () => {
    await show([repair(), repair({ id: 'r2', cardTitle: 'other' })]);
    expect(rows()).toHaveLength(2);
    await click(rows()[1].querySelector('button')!);
    expect(onDismiss).toHaveBeenCalledWith('r2');
  });

  it('gives each dismiss button a name of its own (§5.32)', async () => {
    // three buttons all reading "Got it" would be three identical controls to
    // anyone who cannot see which row they sit in
    await show([repair(), repair({ id: 'r2', cardTitle: 'other' })]);
    const names = rows().map((r) => r.querySelector('button')!.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toContain('Switchboard.ai');
  });

  it('keeps the panel from claiming to be empty while it is up', async () => {
    await show([repair()]);
    expect(host.textContent).not.toContain(en.events.empty);
  });

  it('shows nothing for an empty list', async () => {
    await show([]);
    expect(host.querySelector('[data-events-notice="history-repair"]')).toBeNull();
    expect(host.textContent).toContain(en.events.empty);
  });
});

// --- The reviewed row's de-emphasis is a token pair, not an opacity (#268) ---
//
// `tokens.drift.test.ts` measures the pair the reviewed row paints — the fill
// and the ink written on it — but it reads a stylesheet, and the defect it was
// written for was an INLINE `opacity: 0.82` on the row div. That is invisible
// to it: put the opacity back beside the class and every ratio over there
// still passes, while every colour on the row loses about a point of contrast.
//
// So this is the half that has to live in the component: the row asks for the
// de-emphasis by ATTRIBUTE, and asks for nothing else. Group opacity is the
// mechanism this issue removed and the one an eye cannot audit, so it is named
// rather than left to "no inline style at all" — a row is entitled to its
// outline and its radius.
describe('a reviewed row recedes by token, never by opacity', () => {
  const evt = (id: number, kind: EventDto['kind']): EventDto => ({
    id,
    sessionId: 's1',
    kind,
    at: '2026-08-21T10:00:00.000Z',
  });

  async function rowsFor(events: EventDto[]): Promise<HTMLElement[]> {
    await act(async () => {
      root!.render(
        <EventsPanel
          sessions={[{ id: 's1', title: 'alpha', accent: 'var(--accent-blue)' }]}
          events={events}
          queueEvents={events}
          visited={new Set<number>()}
          onFocus={() => {}}
          onVisit={() => {}}
          queueBinding="Ctrl+Space"
          {...V2}
          {...handlers}
        />
      );
    });
    return [...host.querySelectorAll<HTMLElement>('[role="listitem"]')];
  }

  it('marks the reviewed row, and only the reviewed row', async () => {
    const [needy, reviewed] = await rowsFor([evt(1, 'needs-input'), evt(2, 'ready')]);
    expect(reviewed.getAttribute('data-reviewed')).toBe('true');
    expect(needy.getAttribute('data-reviewed')).toBeNull();
    // the attribute only does anything through the rule that reads it
    for (const row of [needy, reviewed]) expect([...row.classList]).toContain('event-row');
  });

  it('sets no inline opacity on either kind of row', async () => {
    for (const row of await rowsFor([evt(1, 'needs-input'), evt(2, 'ready')])) {
      expect(
        row.style.opacity,
        'group opacity fades the text AND the fill toward what is behind both — ' +
          'it takes contrast off every colour on the row at once, and no token test can see it'
      ).toBe('');
    }
  });

  it("writes the row's TITLE in the row's own ink", async () => {
    // The title is the loudest thing on the row and is therefore what the
    // de-emphasis is mostly made of: `--text` on a live row, one rung down the
    // neutral ladder on a reviewed one. Spelling either token here would put
    // the step in a component, where nothing measures it — and reverting this
    // to a fixed `var(--text)` is not an AA failure (it is MORE contrast), it
    // is the reviewed tail quietly ceasing to recede at all, which is the one
    // regression a contrast test cannot have an opinion about.
    for (const row of await rowsFor([evt(1, 'needs-input'), evt(2, 'ready')])) {
      const title = [...row.querySelectorAll<HTMLElement>('span')].find(
        (w) => w.textContent === 'alpha'
      );
      expect(title, 'the row stopped naming its session').toBeDefined();
      expect(title!.style.color).toBe('inherit');
    }
  });

  it("writes the reviewed row's state word in the row's own ink", async () => {
    // The one word on a reviewed row that says what the row IS. It used to
    // carry its own token (`--faint`, the app's hairline hint) and measured
    // 2.15:1 with the old opacity folded in — a value no test in the token
    // suite could reach, because the map that held it is a component's. It
    // inherits now, so the colour on screen IS the pair
    // `.event-row[data-reviewed='true']` declares and tokens.drift.test.ts
    // measures. A token named here again would be a second opinion about it.
    const [, reviewed] = await rowsFor([evt(1, 'needs-input'), evt(2, 'ready')]);
    const words = [...reviewed.querySelectorAll<HTMLElement>('span')];
    const state = words.find((w) => w.textContent?.startsWith(en.events.kind.ready));
    expect(state, 'the reviewed row stopped saying what state it is in').toBeDefined();
    expect(
      state!.style.color,
      'a colour of its own here is a colour the drift test cannot see'
    ).toBe('inherit');
  });

  it('leaves the fill to the stylesheet, so the pair stays measurable', async () => {
    // an inline background would beat the rule on specificity and the drift
    // test would be measuring a colour nobody paints
    for (const row of await rowsFor([evt(1, 'needs-input'), evt(2, 'ready')])) {
      expect(row.style.background).toBe('');
      expect(row.style.backgroundColor).toBe('');
    }
  });
});

// P2-E14-02: a row that can ANSWER, and the filters above the rows.
describe('Events v2: inline decisions, questions, filters', () => {
  const ALPHA = { id: 'card-a', liveId: 'live-a', title: 'alpha' };
  const BETA = { id: 'card-b', liveId: 'live-b', title: 'beta' };
  const perm = (requestId: string, sessionId: string, command = 'npm test'): PermissionRequestDto => ({
    requestId,
    sessionId,
    tool: 'Bash',
    input: { command },
  });
  const question = (requestId: string, sessionId: string): PermissionRequestDto => ({
    requestId,
    sessionId,
    tool: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Which colour?',
          header: 'Colour',
          options: [{ label: 'Red' }, { label: 'Blue' }],
          multiSelect: false,
        },
        { question: 'Which size?', options: [{ label: 'S' }, { label: 'L' }], multiSelect: false },
      ],
    },
  });
  const onDecide = vi.fn();
  const onAllowAll = vi.fn();
  const onFocus = vi.fn();
  const onFilter = vi.fn();

  beforeEach(() => {
    for (const f of [onDecide, onAllowAll, onFocus, onFilter]) f.mockReset();
    // the row's open gesture acks the event; nothing here is about that
    (window as unknown as { switchboard: unknown }).switchboard = {
      events: { ack: vi.fn(() => Promise.resolve()), dismiss: vi.fn(() => Promise.resolve()) },
    };
  });

  async function show(
    events: EventDto[],
    held: PermissionRequestDto[],
    filter: EventsFilter = 'all',
    railOrder: string[] = ['card-a', 'card-b']
  ): Promise<void> {
    await act(async () => {
      root!.render(
        <EventsPanel
          sessions={[ALPHA, BETA]}
          events={events}
          queueEvents={events}
          visited={new Set<number>()}
          onFocus={onFocus}
          onVisit={() => {}}
          queueBinding="Ctrl+Space"
          held={held}
          onDecidePermission={onDecide}
          onAllowAllSession={onAllowAll}
          filter={filter}
          onFilterChange={onFilter}
          railOrder={railOrder}
        />
      );
    });
  }
  const e = (id: number, sessionId: string, kind: EventDto['kind']): EventDto => ({
    id,
    sessionId,
    kind,
    at: `2026-09-22T10:0${id}:00.000Z`,
  });
  const q = <T extends Element = HTMLElement>(sel: string): T => {
    const el = host.querySelector<T>(sel);
    if (!el) throw new Error(`nothing matches ${sel}`);
    return el;
  };

  it('Allow and Deny answer THAT request, and never open the card', async () => {
    await show([e(1, 'live-a', 'needs-permission')], [perm('r1', 'live-a')]);
    expect(q('[data-event-permission="r1"]').textContent).toContain('npm test');
    await click(q('[data-event-deny="r1"]'));
    expect(onDecide).toHaveBeenCalledWith('r1', 'deny');
    // the done-when: answered "with the card never focused"
    expect(onFocus).not.toHaveBeenCalled();
    // …and a click on the box between the buttons does not fall through either
    await click(q('[data-event-held="live-a"]'));
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('a click disarms the row until a DIFFERENT request has been showing for a beat', async () => {
    vi.useFakeTimers();
    try {
      await show([e(1, 'live-a', 'needs-permission')], [perm('r1', 'live-a'), perm('r2', 'live-a', 'git push')]);
      await click(q('[data-event-allow="r1"]'));
      expect(onDecide.mock.calls).toEqual([['r1', 'allow']]);
      // the double-click: swallowed, because nothing has resolved yet
      await click(q('[data-event-allow="r1"]'));
      expect(onDecide).toHaveBeenCalledTimes(1);

      // r1 resolves and r2 slides in UNDER THE POINTER — still disarmed
      await show([e(1, 'live-a', 'needs-permission')], [perm('r2', 'live-a', 'git push')]);
      expect(q<HTMLButtonElement>('[data-event-allow="r2"]').disabled).toBe(true);
      await click(q('[data-event-allow="r2"]'));
      expect(onDecide).toHaveBeenCalledTimes(1);

      // …and armed once it has been on screen long enough to read
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(q<HTMLButtonElement>('[data-event-allow="r2"]').disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an answer that never lands re-arms the buttons rather than leaving them dead', async () => {
    vi.useFakeTimers();
    try {
      await show([e(1, 'live-a', 'needs-permission')], [perm('r1', 'live-a')]);
      await click(q('[data-event-allow="r1"]'));
      expect(q<HTMLButtonElement>('[data-event-allow="r1"]').disabled).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(q<HTMLButtonElement>('[data-event-allow="r1"]').disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('each row answers only its own session: denying beta leaves alpha alone', async () => {
    await show(
      [e(1, 'live-a', 'needs-permission'), e(2, 'live-b', 'needs-permission')],
      [perm('ra', 'live-a'), perm('rb', 'live-b', 'rm -rf build')]
    );
    await click(q('[data-event-deny="rb"]'));
    expect(onDecide.mock.calls).toEqual([['rb', 'deny']]);
    // named per session, so a screen reader can tell the two rows' Denies apart
    expect(q('[data-event-deny="ra"]').getAttribute('aria-label')).toBe('Deny Bash in alpha');
    expect(q('[data-event-deny="rb"]').getAttribute('aria-label')).toBe('Deny Bash in beta');
    // WCAG 2.5.3: every spoken name starts with the words on the button
    for (const b of host.querySelectorAll<HTMLButtonElement>('[data-event-held] button')) {
      expect((b.getAttribute('aria-label') ?? '').startsWith(b.textContent ?? '')).toBe(true);
    }
  });

  it('Allow all hands over the live id and EVERY permission it holds, and says how many more', async () => {
    await show(
      [e(1, 'live-a', 'needs-permission')],
      [perm('r1', 'live-a'), perm('r2', 'live-a', 'git status'), question('q1', 'live-a')]
    );
    expect(host.textContent).toContain('+1 more');
    await click(q('[data-event-allow-all="live-a"]'));
    // the question is NOT in the list: a standing grant does not answer one
    expect(onAllowAll).toHaveBeenCalledWith('live-a', ['r1', 'r2']);
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('a question row expands into the list of what was asked, with no blind answer on offer', async () => {
    await show([e(1, 'live-a', 'needs-permission')], [question('q1', 'live-a')]);
    // no Allow/Deny: an allow with no answers is "the user did not answer"
    expect(host.querySelector('[data-event-allow]')).toBeNull();
    const toggle = q<HTMLButtonElement>('[data-event-questions="live-a"]');
    expect(toggle.textContent).toContain('2 questions waiting');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[data-testid="event-question-list"]')).toBeNull();

    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const list = q('[data-testid="event-question-list"]');
    expect(toggle.getAttribute('aria-controls')).toBe(list.id);
    expect(list.textContent).toContain('Colour:');
    expect(list.textContent).toContain('Which colour?');
    expect(list.textContent).toContain('Red · Blue');
    expect(list.textContent).toContain('Which size?');
    // expanding is not opening
    expect(onFocus).not.toHaveBeenCalled();

    // "Answer in session" IS opening — that is where a question gets answered
    await click(q('[data-event-answer]'));
    expect(onFocus).toHaveBeenCalledWith('card-a');
  });

  it('a row with nothing held is the row it always was', async () => {
    await show([e(1, 'live-a', 'done')], [perm('rb', 'live-b')]);
    expect(host.querySelector('[data-event-held]')).toBeNull();
  });

  it('renders the three filters with the current one pressed, and reports a pick', async () => {
    await show([e(1, 'live-a', 'done')], [], 'needed');
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-events-filter]')];
    expect(buttons.map((b) => b.textContent)).toEqual(['All', 'Needed', 'By session']);
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    await click(buttons[2]);
    expect(onFilter).toHaveBeenCalledWith('by-session');
  });

  it('Needed with only reviewed rows says the VIEW is empty, not that nothing ever happened', async () => {
    await show([e(1, 'live-a', 'ready')], [], 'needed');
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(0);
    expect(host.querySelector('[data-testid="events-filter-empty"]')).not.toBeNull();
    expect(host.textContent).not.toContain(en.events.empty);
  });

  it('By session lists the rows in rail order', async () => {
    const events = [e(1, 'live-a', 'done'), e(2, 'live-b', 'needs-permission')];
    await show(events, [], 'by-session', ['card-a', 'card-b']);
    const titles = (): string[] =>
      [...host.querySelectorAll('[role="listitem"]')].map((r) =>
        r.textContent?.includes('alpha') ? 'alpha' : 'beta'
      );
    expect(titles()).toEqual(['alpha', 'beta']);
    // …where All still leads with the one that is blocked
    await show(events, [], 'all');
    expect(titles()).toEqual(['beta', 'alpha']);
  });
});

describe('the missed-events digest (P2-E14-05c)', () => {
  const onClear = vi.fn();
  const rec = (id: string, at: number, over: Partial<SuppressedEvent> = {}): SuppressedEvent => ({
    id,
    at,
    kind: 'needs-permission',
    cardId: 'card-a',
    title: 'TradingApp',
    body: 'needs permission',
    actions: ['os-toast', 'sound'],
    ruleIds: ['built-in:toast'],
    reason: 'quiet-hours',
    ...over,
  });

  async function show(held: SuppressedEvent[]): Promise<void> {
    await act(async () => {
      root!.render(
        <EventsPanel
          sessions={[]}
          events={[]}
          queueEvents={[]}
          visited={new Set<number>()}
          onFocus={() => {}}
          onVisit={() => {}}
          queueBinding="Ctrl+Space"
          {...V2}
          digest={buildDigest(held)}
          onClearDigest={onClear}
        />
      );
    });
  }

  const notice = (): HTMLElement | null =>
    host.querySelector<HTMLElement>('[data-events-notice="digest"]');
  const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-digest-row]')];

  beforeEach(() => onClear.mockReset());

  it('renders NOTHING when quiet hours held nothing — the ordinary night', async () => {
    // the calm check: a feature whose job is to do nothing must look like it
    await show([]);
    expect(notice()).toBeNull();
    expect(host.textContent).toContain(en.events.empty);
  });

  it('names each held event by the title captured at the time', async () => {
    await show([rec('a', 1_700_000_000_000, { title: 'the name it had at 03:00' })]);
    expect(notice()).not.toBeNull();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].getAttribute('data-digest-row')).toBe('needs-permission');
    expect(rows()[0].textContent).toContain('the name it had at 03:00');
  });

  it('leads with the newest, not the store’s append order', async () => {
    await show([rec('early', 100, { title: 'first' }), rec('late', 300, { title: 'last' })]);
    expect(rows()[0].textContent).toContain('last');
  });

  it('summarises the ones it does not name', async () => {
    const many = Array.from({ length: DIGEST_ROWS + 3 }, (_, i) =>
      rec(`e${i}`, 1000 + i, { title: `card ${i}` })
    );
    await show(many);
    expect(rows()).toHaveLength(DIGEST_ROWS);
    expect(notice()!.getAttribute('data-digest-total')).toBe(String(DIGEST_ROWS + 3));
    expect(notice()!.textContent).toContain('3 more');
    // THE HEADING COUNTS THE WHOLE NIGHT, not the rows it drew. Unpinned until
    // review deleted the heading outright and 133 tests stayed green — and the
    // count is the one thing that tells the user how much Clear is about to take.
    expect(notice()!.textContent).toContain(`${DIGEST_ROWS + 3} notifications were held`);
    // …and so does the button that destroys them
    expect(notice()!.querySelector('button')!.getAttribute('aria-label')).toContain(
      String(DIGEST_ROWS + 3)
    );
  });

  it('dates a row from an earlier day, and leaves today bare', async () => {
    // a digest spanning midnight must say WHICH night; "03:14" alone does not
    const today = new Date();
    const earlier = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000);
    await show([rec('old', earlier.getTime(), { title: 'from the weekend' })]);
    const expected = earlier.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(rows()[0].textContent).toContain(expected);
    await show([rec('now', today.getTime(), { title: 'this morning' })]);
    const todayStr = today.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(rows()[0].textContent).not.toContain(todayStr);
  });

  it('announces itself — it is already true when the window mounts', async () => {
    // the strongest case for #314's pair in this slot: every row predates the
    // renderer, so there is no later event to notice it by
    await show([rec('a', 1)]);
    const live = notice()!.querySelector('[role="status"]');
    expect(live).not.toBeNull();
    expect(live!.getAttribute('aria-live')).toBe('polite');
  });

  it('clears with EVERY id it accounted for, including the unnamed overflow', async () => {
    const many = Array.from({ length: DIGEST_ROWS + 4 }, (_, i) => rec(`e${i}`, 1000 + i));
    await show(many);
    await click(host.querySelector<HTMLElement>('[data-events-notice="digest"] button')!);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onClear.mock.calls[0][0]).toHaveLength(DIGEST_ROWS + 4);
  });

  it('names its count on the clear button, not just "Clear"', async () => {
    // it destroys the only record of a night nobody watched (§5.32)
    await show([rec('a', 1), rec('b', 2)]);
    const btn = notice()!.querySelector('button')!;
    expect(btn.getAttribute('aria-label')).toContain('2');
  });

  it('says how many SESSIONS only when more than one is involved', async () => {
    await show([rec('a', 1, { cardId: 'card-a' })]);
    expect(notice()!.textContent).not.toContain('across');
    await show([rec('a', 1, { cardId: 'card-a' }), rec('b', 2, { cardId: 'card-b' })]);
    expect(notice()!.textContent).toContain('across 2 sessions');
  });

  it('does not suppress the empty state when it is the only thing absent', async () => {
    // guards the empty-state condition this tenant had to join
    await show([rec('a', 1)]);
    expect(host.textContent).not.toContain(en.events.empty);
  });
});
