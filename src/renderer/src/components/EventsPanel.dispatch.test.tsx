// @vitest-environment jsdom
// The round-trip's row (P2-E13-05, §5.15) — Phase 2 exit criterion 5, at the
// surface.
//
// The row lives on the AUTHOR's card and is the only row in the panel with a
// verb on it: everything else offers Allow/Deny for a question its own session
// is blocked on, while this one hands another session's report to this one.
//
// What is tested here rather than in `dispatch.spec.ts`: the things a real app
// cannot produce on demand — a delivery that refuses, a report that was
// truncated, a reviewer that finished with nothing to say. The e2e proves the
// whole chain once, end to end, with a real session at each end.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { EventsPanel } from './EventsPanel';
import type { EventDto } from '../model/types';
import type { DispatchResultDto } from '../../../shared/dispatch-result';
import type { RailSession } from './SessionsRail';
import { ipcRefusal } from '../../../shared/ipc/refusal';
import { V2 } from './events-panel-test-props';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

const inject = vi.fn();
const dismiss = vi.fn();
const onFocus = vi.fn();

const result = (over: Partial<DispatchResultDto> = {}): DispatchResultDto => ({
  reviewer: 'live-reviewer',
  reviewerName: 'Review of Alpha',
  templateName: 'Code Reviewer',
  outcome: 'reported',
  headline: 'This change does not work.',
  chars: 2867,
  truncated: false,
  ...over,
});

const row = (dispatch: DispatchResultDto): EventDto => ({
  id: 7,
  sessionId: 'live-author',
  kind: 'dispatch-result',
  at: '2026-09-26T10:00:00.000Z',
  dispatch,
});

const author: RailSession = {
  id: 'card-author',
  title: 'Alpha',
  status: 'idle',
  liveId: 'live-author',
} as unknown as RailSession;

const reviewerSession: RailSession = {
  id: 'card-reviewer',
  title: 'Review of Alpha',
  status: 'done',
  liveId: 'live-reviewer',
} as unknown as RailSession;

/**
 * `sessions` DEFAULTS TO THE AUTHOR ALONE, which is the reviewer-has-been-closed
 * case. Every test that wants a reviewer to open passes it explicitly, so the
 * default is the one that has a button missing rather than the one that does not.
 */
async function render(
  events: readonly EventDto[],
  sessions: readonly RailSession[] = [author]
): Promise<void> {
  await act(async () => {
    root!.render(
      <EventsPanel
        sessions={sessions}
        events={events}
        queueEvents={events}
        visited={new Set<number>()}
        onFocus={onFocus}
        onVisit={() => {}}
        queueBinding="Ctrl+Space"
        {...V2}
      />
    );
  });
}

function byAttr(attr: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[${attr}]`);
}
async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  inject.mockReset();
  dismiss.mockReset();
  onFocus.mockReset();
  inject.mockResolvedValue({ ok: true, submitted: false });
  (globalThis as unknown as { window: { switchboard: unknown } }).window.switchboard = {
    dispatch: { inject },
    events: { ack: vi.fn(), dismiss },
  };
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

describe('a finished dispatch, on the author’s row', () => {
  it('names the role and the session that wore it, not "Done."', async () => {
    await render([row(result())]);
    // "Done." would be a statement about the AUTHOR, which is the one session
    // this row is not about.
    expect(host.textContent).toContain('Code Reviewer');
    expect(host.textContent).toContain('Review of Alpha');
    expect(host.textContent).not.toContain(en.events.kind.done);
  });

  it('shows the first line the reviewer wrote, and no invented count', async () => {
    await render([row(result())]);
    expect(host.querySelector('[data-testid="event-dispatch-headline"]')?.textContent).toBe(
      'This change does not work.'
    );
    // §5.15's example says "3 findings". Four probe runs of one prompt enumerated
    // four different ways, so the row counts nothing — see the findings note.
    expect(host.textContent).not.toMatch(/\d+\s+findings/i);
  });

  it('injects with the REVIEWER as the handle', async () => {
    await render([row(result())]);
    await click(byAttr('data-event-inject'));
    expect(inject).toHaveBeenCalledWith('live-reviewer');
  });

  // §5.4's rule is that the block waits for a human keypress unless the card's
  // own auto-accept toggle is on, and the row must not claim one when the other
  // happened. BOTH SENTENCES COME OFF THE ROW, because main re-raises it —
  // which remounts this component under a new event id and would take any
  // confirmation held in `useState` with it.
  it('the row says the block is WAITING once it has been handed over', async () => {
    await render([row(result({ outcome: 'delivered', chars: 0, submitted: false }))]);
    expect(host.textContent).toContain('findings waiting in this session');
    expect(byAttr('data-event-inject')).toBeNull();
  });

  it('…and says so differently when the author accepts siblings automatically', async () => {
    await render([row(result({ outcome: 'delivered', chars: 0, submitted: true }))]);
    expect(host.textContent).toContain('findings sent straight into this session');
    expect(host.textContent).not.toContain('waiting in this session');
  });

  // #765's rule from the other end: the sender must be able to tell "waiting in
  // a composer" from "went nowhere". And a refusal must not eat the finding.
  it('prints the refusal and KEEPS the button', async () => {
    inject.mockResolvedValue({ ok: false, reasonKey: 'undelivered', detail: 'that card was closed' });
    await render([row(result())]);
    await click(byAttr('data-event-inject'));
    const refused = host.querySelector('[data-testid="event-dispatch-refused"]');
    // OUR sentence, not delivery's — which is written for the agent that called
    // it ("send it again as plain text") and is the wrong instruction for a
    // person who did not write the text.
    expect(refused?.textContent).toBe(en.events.dispatch.refused.undelivered);
    // …and delivery's own words are still reachable, as the tooltip.
    expect(refused?.getAttribute('title')).toBe('that card was closed');
    expect(byAttr('data-event-inject')).not.toBeNull();
    await click(byAttr('data-event-inject'));
    expect(inject).toHaveBeenCalledTimes(2);
  });

  // #346/#440/#650: a REFUSED call resolves an `IpcRefusal`, whose `.ok` is
  // `undefined`. Unlaundered, the row would print an empty reason and read as a
  // bug in main rather than as a call that never reached it.
  it('launders a brokered refusal rather than reading `ok` off it', async () => {
    inject.mockResolvedValue(ipcRefusal('dispatch:inject', 'capability-not-held'));
    await render([row(result())]);
    await click(byAttr('data-event-inject'));
    expect(host.querySelector('[data-testid="event-dispatch-refused"]')?.textContent).toContain(
      en.events.dispatch.noAnswer
    );
    expect(byAttr('data-event-inject')).not.toBeNull();
  });

  it('survives the channel itself throwing', async () => {
    inject.mockRejectedValue(new Error('no such channel'));
    await render([row(result())]);
    await click(byAttr('data-event-inject'));
    const refused = host.querySelector('[data-testid="event-dispatch-refused"]');
    // A stack trace is not a sentence: the row says ours and hovers theirs.
    expect(refused?.textContent).toBe(en.events.dispatch.refused.channel);
    expect(refused?.getAttribute('title')).toContain('no such channel');
  });

  it('offers no inject when the session finished with nothing to say', async () => {
    await render([row(result({ outcome: 'silent', chars: 0, headline: undefined }))], [
      author,
      reviewerSession,
    ]);
    expect(byAttr('data-event-inject')).toBeNull();
    // …but the row is still there, because silence is news too (done-when 3).
    expect(host.textContent).toContain('Code Reviewer');
    // and the way to go and look is still offered
    expect(byAttr('data-event-open-reviewer')).not.toBeNull();
  });

  it('offers the inject for a session that ENDED after writing something', async () => {
    await render([row(result({ outcome: 'ended' }))]);
    expect(byAttr('data-event-inject')).not.toBeNull();
  });

  // The used-state has to survive a remount and reach a SECOND Events surface.
  // Main re-raises the row with this outcome; the component's own `done` state is
  // only the extra sentence for the person who clicked.
  it('offers no inject on a row main has already marked delivered', async () => {
    await render([row(result({ outcome: 'delivered', chars: 0, submitted: false }))], [
      author,
      reviewerSession,
    ]);
    expect(byAttr('data-event-inject')).toBeNull();
    expect(host.textContent).toContain('Code Reviewer');
    // …and the headline is still there, because the row still says what came back
    expect(host.querySelector('[data-testid="event-dispatch-headline"]')).not.toBeNull();
  });

  it('says when the report was shortened to fit', async () => {
    await render([row(result({ truncated: true }))]);
    expect(host.textContent).toContain(en.events.dispatch.truncated);
  });

  it('opens the REVIEWER, which is the one session this row is about', async () => {
    await render([row(result())], [author, reviewerSession]);
    await click(byAttr('data-event-open-reviewer'));
    // The CARD, which is what `onFocus` wants where there is one — the same join
    // the row's own open makes.
    expect(onFocus).toHaveBeenCalledWith('card-reviewer');
  });

  // The report deliberately outlives the session that wrote it — closing a
  // finished reviewer's card is documented as safe — so this button's target can
  // be gone while the row is not, and a button that focuses a dead id does
  // nothing visible at all.
  it('says the reviewer is gone instead of offering a button that cannot work', async () => {
    await render([row(result())]); // author only: the reviewer has been closed
    expect(byAttr('data-event-open-reviewer')).toBeNull();
    expect(host.textContent).toContain(en.events.dispatch.reviewerGone);
    // …and Inject still works, because the report is main's, not the card's.
    expect(byAttr('data-event-inject')).not.toBeNull();
  });

  // With two rows on one session, dismissing by session alone would take the
  // author's own held permission down with the finding.
  it('dismisses by EVENT ID as well as by session', async () => {
    await render([row(result())]);
    await click([...host.querySelectorAll('.event-dismiss')][0]);
    expect(dismiss).toHaveBeenCalledWith('live-author', 7);
  });

  it('shows no Allow/Deny — this row is not a held permission', async () => {
    await render([row(result())]);
    expect(byAttr('data-event-allow')).toBeNull();
    expect(byAttr('data-event-deny')).toBeNull();
  });
});
