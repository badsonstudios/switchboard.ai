// @vitest-environment jsdom
// P2-E11-07: `@session` autocomplete in the composer.
//
// Mounted through the real panel contribution, with the same harness
// `FeedView.sibling.test.tsx` uses, so a wiring defect — a row never rendered,
// an Enter that completes instead of sending — is caught here rather than by
// the pure tables in `shared/mention-token.test.ts`, which cannot see it.
//
// Every test that could plausibly send ALSO counts what reached main's typed
// route (`sessions.submitPrompt`), because several of the rules here are about a
// key that must NOT send — and several about one that must.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';
import { loadUiState } from '../lib/ui-state';
import { ipcRefusal } from '../../../shared/ipc/refusal';
import {
  SIBLING_SETTLE_MS,
  heldMessages,
  receiveSiblingMessage,
  resetInboxCacheForTests,
} from '../lib/sibling-inbox';
import type { SiblingMessage } from '../../../shared/sibling-message';
import type { SessionSummary } from '../../../shared/sessions';
import type { SlashCommand } from '../../../shared/slash-commands';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// jsdom implements no layout, so it has no `scrollIntoView`. The composer calls
// it to keep the highlighted popup row visible, which only matters in a real
// browser; the existing composer tests never opened a popup WITH rows, so they
// never reached it. A no-op here, not a guard in the component.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

/** everything that reached main's typed-message route */
let submitted: string[];
let summaryFetches: number;
/** `sessions.summaries` behaviour for the next call */
let summariesMode: 'resolve' | 'hold' | 'refuse' | 'reject';
let releaseSummaries: (() => void) | null = null;
/** what main's `sessions.resolveMentions` answers (P2-E11-08); every call is recorded */
let resolveMentions: (id: string, text: string) => Promise<unknown>;
let resolveCalls: Array<[string, string]>;
const roots: Root[] = [];

/** The composer below is mounted as `live-b` / "Beta" — its OWN session. */
const OWN_ID = 'live-b';

// Matching is case-insensitive SUBSTRING with prefix matches first, then
// alphabetical — so "Tra" matches BOTH Trackpad and TradingApp (Trackpad first),
// and a test that wants TradingApp alone types "Trad".
const SESSIONS: SessionSummary[] = [
  { id: 'live-a', name: 'TradingApp', folder: '/p/trading', providerId: 'claude-code', status: 'working', exited: false, accentColor: 'var(--accent-teal)' },
  { id: 'live-c', name: 'Trackpad', folder: '/p/trackpad', providerId: 'claude-code', status: 'done', exited: true },
  { id: 'live-d', name: 'BrainHarbor', folder: '/p/brain', providerId: 'claude-code', status: 'idle', exited: false, accentColor: 'var(--accent-rose)' },
  { id: OWN_ID, name: 'Beta', folder: '/p/beta', providerId: 'claude-code', status: 'working', exited: false },
];

const COMMANDS: SlashCommand[] = [{ name: 'clear', description: 'Clear the conversation', source: 'builtin' }];

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: { blocks: () => Promise.resolve([]), onBlock: () => () => {}, onReset: () => () => {} },
    pty: { input: () => {} },
    workspace: { getUi: () => Promise.resolve({}), setUi: () => {} },
    sessions: {
      slashCommands: () => Promise.resolve(COMMANDS),
      summaries: () => {
        summaryFetches++;
        switch (summariesMode) {
          case 'hold':
            return new Promise<SessionSummary[]>((resolve) => {
              releaseSummaries = () => resolve(SESSIONS);
            });
          case 'refuse':
            // `answered()` keys on the refusal BRAND; the reason is irrelevant here.
            return Promise.resolve(ipcRefusal('sessions:summaries', 'capability' as Parameters<typeof ipcRefusal>[1]));
          case 'reject':
            return Promise.reject(new Error('the invoke itself failed'));
          default:
            return Promise.resolve(SESSIONS);
        }
      },
      resolveMentions: (id: string, text: string) => resolveMentions(id, text),
      submitPrompt: (_id: string, text: string) => {
        submitted.push(text);
        return Promise.resolve(true);
      },
    },
  };
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const ctx: PanelContext = {
    sessionId: OWN_ID,
    cardId: 'card-b',
    title: 'Beta',
    visible: true,
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    transport: 'stream',
    setView: () => {},
  };
  await act(async () => {
    root.render(feedPanel.render(ctx));
  });
  return host;
}

const boxOf = (host: HTMLElement): HTMLTextAreaElement => host.querySelector('textarea')!;
const rows = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-completion-row]')];
const mentionRows = (host: HTMLElement): HTMLElement[] =>
  [...host.querySelectorAll<HTMLElement>('[data-completion-row="mention"]')];
const labels = (host: HTMLElement): string[] =>
  rows(host).map((r) => r.querySelector<HTMLElement>('[data-completion-label]')?.textContent ?? '');

/** let the popup's list fetch resolve and React commit it */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Type into the CONTROLLED textarea, through the setter React's tracker patched. */
async function type(host: HTMLElement, text: string): Promise<void> {
  const box = boxOf(host);
  const valueProp = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
  await act(async () => {
    valueProp.set!.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

async function press(host: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    boxOf(host).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

/** Move the caret the way a click or arrow-in-text does: the composer syncs it on keyup. */
async function caretTo(host: HTMLElement, pos: number): Promise<void> {
  const box = boxOf(host);
  await act(async () => {
    box.setSelectionRange(pos, pos);
    box.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
  });
  await flush();
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  submitted = [];
  summaryFetches = 0;
  summariesMode = 'resolve';
  releaseSummaries = null;
  resolveCalls = [];
  // Default: main resolves nothing, so the draft comes back exactly as typed —
  // which is also what every pre-#798 test in this file expects to be sent.
  resolveMentions = (id, text) => {
    resolveCalls.push([id, text]);
    return Promise.resolve({ ok: true, prompt: text });
  };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  await initI18nForTests();
  stubBridge();
  await loadUiState();
});

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await act(async () => r.unmount());
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('typing @ opens the session list', () => {
  it('lists matching sessions, prefix matches first, never the composer’s own session', async () => {
    const host = await mount();
    await type(host, '@');
    // Everyone but "Beta" (this card's own session), alphabetical.
    expect(labels(host)).toEqual(['@BrainHarbor', '@Trackpad', '@TradingApp']);
    await type(host, '@Tr');
    expect(labels(host)).toEqual(['@Trackpad', '@TradingApp']);
    await type(host, '@Trad');
    expect(labels(host)).toEqual(['@TradingApp']);
    expect(submitted).toEqual([]);
  });

  it('comes from the SAME summaries the bus answers with — one fetch per popup opening', async () => {
    const host = await mount();
    await type(host, '@');
    await type(host, '@T');
    await type(host, '@Tr');
    // Fetched on OPENING, not per keystroke (the same rule as the slash list).
    expect(summaryFetches).toBe(1);
  });

  it('shows each session’s folder, marks an EXITED session, and paints its colour', async () => {
    const host = await mount();
    await type(host, '@Tr');
    const [trackpad, trading] = rows(host);
    expect(trackpad.textContent).toContain('/p/trackpad');
    expect(trackpad.textContent).toContain('exited');
    expect(trading.textContent).not.toContain('exited');
    const dot = (r: HTMLElement) => r.querySelector<HTMLElement>('span[aria-hidden="true"]')!;
    expect(dot(trading).style.background).toBe('var(--accent-teal)');
    // No colour on the record → the same backstop every session row uses.
    expect(dot(trackpad).style.background).toBe('var(--faint)');
  });

  it('never offers the own session even when the typed prefix matches it', async () => {
    const host = await mount();
    await type(host, '@Be');
    expect(labels(host)).toEqual([]);
  });

  it('opens only with the caret at the END of the @word — not inside a mention already typed', async () => {
    // Review blocker (#797): with the caret inside `@TradingApp`, a token of
    // "Tr" opened the popup and Enter replaced it, leaving `@Trackpad adingApp`.
    const host = await mount();
    await type(host, 'hey @TradingApp please');
    await caretTo(host, 7); // hey @Tr|adingApp please
    expect(rows(host)).toHaveLength(0);
    await press(host, 'Enter');
    expect(submitted).toEqual(['hey @TradingApp please']);
  });
});

describe('choosing a session', () => {
  it('Tab inserts @Name mid-sentence, keeps the text before it, and puts the caret after it', async () => {
    const host = await mount();
    await type(host, 'take @Trad');
    await press(host, 'Tab');
    expect(boxOf(host).value).toBe('take @TradingApp ');
    // Where the caret lands is its own rule: the slash arithmetic would leave it
    // mid-text (#797 review).
    expect(boxOf(host).selectionStart).toBe('take @TradingApp '.length);
    expect(submitted).toEqual([]);
  });

  it('ArrowDown then Enter on a PARTIAL name completes the highlighted row, and does NOT send', async () => {
    const host = await mount();
    await type(host, '@Tr');
    await press(host, 'ArrowDown'); // Trackpad → TradingApp
    await press(host, 'Enter');
    expect(boxOf(host).value).toBe('@TradingApp ');
    expect(submitted).toEqual([]);
  });

  it('Enter on a name typed IN FULL sends the draft as typed (#163’s rule, applied to @)', async () => {
    const host = await mount();
    await type(host, '@TradingApp');
    expect(labels(host)).toEqual(['@TradingApp']); // the popup is open, and it is complete
    await press(host, 'Enter');
    expect(submitted).toEqual(['@TradingApp']);
  });

  it('Enter on a SUBSTRING match sends the literal text — it never swaps in a name nobody chose', async () => {
    // Review (#797): `ping @app` with a session called TradingApp became
    // `@TradingApp`, which #798's negative table forbids.
    const host = await mount();
    await type(host, 'ping @app');
    expect(labels(host)).toEqual(['@TradingApp']); // offered…
    await press(host, 'Enter');
    expect(submitted).toEqual(['ping @app']); // …but not forced
  });

  it('…unless the user MOVED to that row — then Enter completes it', async () => {
    const host = await mount();
    await type(host, 'ping @app');
    await press(host, 'ArrowDown'); // one row: wraps onto itself, but it is a choice
    await press(host, 'Enter');
    expect(boxOf(host).value).toBe('ping @TradingApp ');
    expect(submitted).toEqual([]);
  });

  it('the highlight and the "moved" flag RESET when the typed word changes', async () => {
    // Mutation round 1 (#797): removing the reset survived every test, because
    // none moved the selection and then retyped.
    const host = await mount();
    await type(host, '@Tr');
    await press(host, 'ArrowDown'); // TradingApp, navigated
    await type(host, '@T'); // rows: Trackpad, TradingApp — selection must be back on row 0
    await press(host, 'Enter');
    expect(boxOf(host).value).toBe('@Trackpad ');
  });
});

describe('what counts as CHOOSING a row (mutation round 2, #797)', () => {
  // Both of these survived round 2: every earlier test either never moved to a
  // row, or moved with the arrows and then typed a PREFIX — where Enter
  // completes whether or not "moved" was set. Only a bare SUBSTRING match makes
  // the flag decide the outcome, so both tests are built on `ping @app`.

  it('pointing at a row with the mouse is choosing it — Enter then completes a substring match', async () => {
    const host = await mount();
    await type(host, 'ping @app');
    const [row] = rows(host);
    expect(labels(host)).toEqual(['@TradingApp']);
    await act(async () => {
      // React derives onMouseEnter from a `mouseover`, but IGNORES one whose
      // relatedTarget is another React-managed node (it waits for that node's
      // `mouseout` instead) — the first version of this test named the textarea
      // there, and the hover silently never happened. No relatedTarget is a
      // pointer arriving from outside, which React turns into an enter.
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await press(host, 'Enter');
    expect(boxOf(host).value).toBe('ping @TradingApp ');
    expect(submitted).toEqual([]);
  });

  it('a row chosen for ONE word does not carry over to the next — Enter on a new substring match sends', async () => {
    const host = await mount();
    await type(host, '@Tr');
    await press(host, 'ArrowDown'); // chosen, for "Tr"
    await type(host, 'ping @app'); // a different word: nothing has been chosen for it
    await press(host, 'Enter');
    expect(submitted).toEqual(['ping @app']);
  });
});

describe('while the session list is still loading, or fails', () => {
  // Found by mutation, not by reading (#797 round 1): removing the mention half
  // of the in-flight guard SURVIVED, because `type` lets the list resolve before
  // any key is pressed. Held open here instead.
  //
  // The case that matters is a FULL name: with no list yet the popup is not
  // open, so without the guard Enter falls through to the plain "Enter sends"
  // branch and the draft goes before the user could have picked anything.
  it('Enter and Tab do nothing while it loads — then work once it arrives', async () => {
    summariesMode = 'hold';
    const host = await mount();
    await type(host, '@TradingApp');
    expect(releaseSummaries).not.toBeNull(); // witness: the fetch is really pending
    expect(rows(host)).toHaveLength(0);

    await press(host, 'Enter');
    await press(host, 'Tab');
    expect(submitted).toEqual([]);
    expect(boxOf(host).value).toBe('@TradingApp');

    await act(async () => {
      releaseSummaries!();
    });
    await flush();
    expect(labels(host)).toEqual(['@TradingApp']);
    await press(host, 'Enter');
    expect(submitted).toEqual(['@TradingApp']);
  });

  it('a REFUSED read is an answer: no rows, and Enter is not held hostage', async () => {
    summariesMode = 'refuse';
    const host = await mount();
    await type(host, '@Tr');
    expect(rows(host)).toHaveLength(0);
    await press(host, 'Enter');
    expect(submitted).toEqual(['@Tr']);
  });

  it('a FAILED read is too — a rejected invoke must not leave Enter swallowed for ever', async () => {
    summariesMode = 'reject';
    const host = await mount();
    await type(host, '@Tr');
    expect(rows(host)).toHaveLength(0);
    await press(host, 'Enter');
    expect(submitted).toEqual(['@Tr']);
  });

  it('reopening the list does not flash the OLD one before the new fetch lands', async () => {
    const host = await mount();
    await type(host, '@Tr');
    expect(rows(host)).toHaveLength(2); // first opening, resolved
    await type(host, 'hello '); // the @ is gone: the list is forgotten
    summariesMode = 'hold';
    await type(host, 'hello @Tr'); // a new opening, still loading
    expect(rows(host)).toHaveLength(0); // not the stale rows from the first opening
    await press(host, 'Enter');
    expect(submitted).toEqual([]); // and Enter is held, as for any list still loading
  });
});

describe('dismissal and no-match', () => {
  it('Escape closes the list FOR THAT @WORD — typing more of it stays closed', async () => {
    // Review (#797): the done-when says Escape "stays dismissed for that token".
    const host = await mount();
    await type(host, '@Tr');
    expect(rows(host)).toHaveLength(2);
    await press(host, 'Escape');
    expect(rows(host)).toHaveLength(0);
    await type(host, '@Tra');
    expect(rows(host)).toHaveLength(0);
  });

  it('…and a NEW @ elsewhere opens the list again', async () => {
    const host = await mount();
    await type(host, '@Tr');
    await press(host, 'Escape');
    await type(host, '@Tr and @Br');
    expect(labels(host)).toEqual(['@BrainHarbor']);
  });

  it('…and deleting that @word and typing it again opens the list again', async () => {
    // Mutation round 2 (#797): with the dismissal never FORGOTTEN, every test
    // above still passed — a dismissal is keyed on the `@`'s position, so a new
    // `@` further along reopens either way. Retyping at the SAME position is the
    // case that needs the forgetting: the user deleted the word, and a word they
    // start again is a new one.
    const host = await mount();
    await type(host, '@Tr');
    await press(host, 'Escape');
    expect(rows(host)).toHaveLength(0);
    await type(host, ''); // the @word is gone
    await type(host, '@Tr'); // …and started again, at the same position
    expect(labels(host)).toEqual(['@Trackpad', '@TradingApp']);
  });

  it('no session matches → no popup at all, not an empty box', async () => {
    const host = await mount();
    await type(host, '@media');
    expect(rows(host)).toHaveLength(0);
  });
});

describe('an @ in ordinary prose', () => {
  it('opens nothing, and the text is sent unchanged', async () => {
    const host = await mount();
    await type(host, 'mail dan@example.com');
    expect(rows(host)).toHaveLength(0);
    await press(host, 'Enter');
    expect(submitted).toEqual(['mail dan@example.com']);
  });
});

describe('sending a draft that mentions a session (P2-E11-08)', () => {
  const notice = (host: HTMLElement): string =>
    host.querySelector<HTMLElement>('[data-composer-attach-notice]')?.textContent ?? '';

  it('asks main about THIS session’s draft, sends the prompt main built, and clears the box', async () => {
    resolveMentions = (id, text) => {
      resolveCalls.push([id, text]);
      return Promise.resolve({ ok: true, prompt: 'CONTEXT BLOCK\n\ntake "TradingApp" (session) now' });
    };
    const host = await mount();
    await type(host, 'take @TradingApp now');
    await press(host, 'Enter');

    expect(resolveCalls).toEqual([[OWN_ID, 'take @TradingApp now']]);
    expect(submitted).toEqual(['CONTEXT BLOCK\n\ntake "TradingApp" (session) now']);
    expect(boxOf(host).value).toBe('');
    expect(notice(host)).toBe('');
  });

  it('a draft with no @ at a word boundary never asks main — the instant path is untouched', async () => {
    const host = await mount();
    await type(host, 'mail dan@example.com');
    await press(host, 'Enter');
    expect(resolveCalls).toEqual([]);
    expect(submitted).toEqual(['mail dan@example.com']);
  });

  it('a SLASH COMMAND is never resolved, @ or not', async () => {
    const host = await mount();
    await type(host, '/review @TradingApp');
    await press(host, 'Escape'); // close the slash popup so Enter sends
    await press(host, 'Enter');
    expect(resolveCalls).toEqual([]);
    expect(submitted).toEqual(['/review @TradingApp']);
  });

  it('an AMBIGUOUS name: nothing is sent, the draft stays, and the reason is under the box', async () => {
    const reason = '"TradingApp" is ambiguous — 2 sessions share that name: TradingApp (live-a, /p/trading); TradingApp (live-z, /p/t2). Use the session id.';
    resolveMentions = () => Promise.resolve({ ok: false, refusals: [reason] });
    const host = await mount();
    await type(host, 'take @TradingApp now');
    await press(host, 'Enter');

    expect(submitted).toEqual([]);
    expect(boxOf(host).value).toBe('take @TradingApp now');
    expect(notice(host)).toContain('Not sent');
    expect(notice(host)).toContain('/p/t2');
  });

  it('the lookup FAILING fails open: sent as typed, and the box says the context did not go', async () => {
    resolveMentions = () => Promise.reject(new Error('main is gone'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const host = await mount();
    await type(host, 'take @TradingApp now');
    await press(host, 'Enter');

    expect(submitted).toEqual(['take @TradingApp now']);
    expect(boxOf(host).value).toBe('');
    expect(notice(host)).toContain("couldn't look up the sessions you mentioned");
  });

  it('a second Enter while the lookup is out sends NOTHING more (#774’s one-send guard)', async () => {
    let release: (() => void) | null = null;
    resolveMentions = (id, text) => {
      resolveCalls.push([id, text]);
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, prompt: text });
      });
    };
    const host = await mount();
    await type(host, 'take @TradingApp now');
    await press(host, 'Enter');
    await press(host, 'Enter');
    expect(resolveCalls).toHaveLength(1);
    expect(submitted).toEqual([]);

    await act(async () => release!());
    await flush();
    expect(submitted).toEqual(['take @TradingApp now']);
  });
});

// Both of these were named by the #798 review as mutants that survived the
// suite: the guard release, and the one place forwarded messages and mention
// resolution meet.
describe('a mention send and the rest of the composer', () => {
  /** A settled sibling message on this card, the way `App.tsx` delivers one. */
  async function heldMessageArrives(text: string): Promise<void> {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const m: SiblingMessage = {
      deliveryId: 'd1',
      cardId: 'card-b',
      from: { id: 'live-a', name: 'TradingApp' },
      text,
      at: new Date(now).toISOString(),
    };
    await act(async () => {
      receiveSiblingMessage(m);
    });
    // SETTLED: a message that arrived less than `SIBLING_SETTLE_MS` ago is not
    // one the user has reviewed, and rides the NEXT Enter by design (#765).
    now += SIBLING_SETTLE_MS + 1;
    await flush();
  }

  afterEach(() => {
    resetInboxCacheForTests();
  });

  it('releases the one-send guard, so the NEXT draft still sends', async () => {
    const host = await mount();
    await type(host, 'take @TradingApp now');
    await press(host, 'Enter');
    expect(submitted).toHaveLength(1);

    // The mutant this kills: dropping `done()` from the resolution callback.
    // The card would stay in-flight for ever — Send greyed, Enter dead, across
    // remounts, clearable only by closing the card.
    await type(host, 'and another one');
    await press(host, 'Enter');
    expect(submitted).toEqual(['take @TradingApp now', 'and another one']);
  });

  it('releases it after a REFUSAL too — an ambiguous name must not wedge the box', async () => {
    resolveMentions = () => Promise.resolve({ ok: false, refusals: ['"TradingApp" is ambiguous'] });
    const host = await mount();
    await type(host, 'take @TradingApp now');
    await press(host, 'Enter');
    expect(submitted).toEqual([]);

    resolveMentions = (_id, text) => Promise.resolve({ ok: true, prompt: text });
    await type(host, 'never mind then');
    await press(host, 'Enter');
    expect(submitted).toEqual(['never mind then']);
  });

  it('carries held sibling messages with it, ahead of the injected context, and forwards them ONCE', async () => {
    resolveMentions = (id, text) => {
      resolveCalls.push([id, text]);
      return Promise.resolve({ ok: true, prompt: `CONTEXT\n\ntake "TradingApp" (session) now` });
    };
    const host = await mount();
    await heldMessageArrives('the regulator is the fault');
    await type(host, 'take @TradingApp now');
    await press(host, 'Enter');

    expect(submitted).toHaveLength(1);
    const sent = submitted[0];
    // The forwarded message leads, then the injected context, then the prose —
    // and ONLY the user's own text was sent for resolution.
    expect(resolveCalls).toEqual([[OWN_ID, 'take @TradingApp now']]);
    expect(sent).toContain('the regulator is the fault');
    expect(sent.indexOf('the regulator is the fault')).toBeLessThan(sent.indexOf('CONTEXT'));
    expect(sent).toContain('CONTEXT\n\ntake "TradingApp" (session) now');
    // …and it is gone from the card, so a second Enter cannot send it again.
    expect(heldMessages('card-b')).toHaveLength(0);
    await type(host, 'anything else');
    await press(host, 'Enter');
    expect(submitted[1]).toBe('anything else');
  });
});

describe('the slash popup is unchanged by the generalisation', () => {
  it('still lists /commands with their source badge, and Tab inserts one', async () => {
    const host = await mount();
    await type(host, '/cl');
    expect(labels(host)).toEqual(['/clear']);
    expect(rows(host)[0].getAttribute('data-completion-row')).toBe('slash');
    expect(rows(host)[0].textContent).toContain('CLI');
    expect(summaryFetches).toBe(0); // a slash popup never asks for sessions
    await press(host, 'Tab');
    expect(boxOf(host).value).toBe('/clear ');
  });

  it('a draft where BOTH tokens hold (`/(@Tr`) keeps the slash reading and never asks for sessions', async () => {
    const host = await mount();
    await type(host, '/(@Tr');
    expect(mentionRows(host)).toHaveLength(0);
    expect(summaryFetches).toBe(0);
  });
});
