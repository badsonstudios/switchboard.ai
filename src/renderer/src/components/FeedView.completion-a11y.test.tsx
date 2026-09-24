// @vitest-environment jsdom
// The composer's completion popup has listbox semantics (#828).
//
// WHAT WAS WRONG, stated as the user experienced it: the popup was a `<div>` of
// `<div>`s and the highlight was `background: var(--chip)` and nothing else. So
// a screen-reader user typing `/` or `@` was told nothing — not that a list had
// opened, not which row ArrowDown had just moved to, not that Enter would
// complete rather than send. The list was visible to exactly one sense.
//
// Focus stays in the textarea, which is correct and is not changing: a
// completion popup that stole focus would break the typing it exists to help.
// That is why `aria-activedescendant` is the mechanism — it carries the
// highlight to a screen reader without moving the caret.
//
// ONE POPUP, TWO TRIGGERS. `/` and `@` share a single renderer
// (`CompletionRow`), which is why the issue could file them together and why
// every relation below is asserted for both. A fix that only reached one of
// them would mean the renderer had been forked.
//
// Mounted through the REAL panel contribution, not by handing `FeedView` props:
// the #174/#196 rule. A test that constructs the component itself stays green
// with the thread from `PanelContext` cut, and the thread is the half that
// ships.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';
import { loadUiState } from '../lib/ui-state';
import type { SessionSummary } from '../../../shared/sessions';
import type { SlashCommand } from '../../../shared/slash-commands';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// jsdom has no layout, so no `scrollIntoView`. The composer calls it to keep the
// highlighted row visible, which only matters in a real browser.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

const OWN_ID = 'live-b';

const SESSIONS: SessionSummary[] = [
  { id: 'live-a', name: 'TradingApp', folder: '/p/trading', providerId: 'claude-code', status: 'working', exited: false, accentColor: 'var(--accent-teal)' },
  { id: 'live-c', name: 'Trackpad', folder: '/p/trackpad', providerId: 'claude-code', status: 'done', exited: true },
  { id: OWN_ID, name: 'Beta', folder: '/p/beta', providerId: 'claude-code', status: 'working', exited: false },
];

// Three, deliberately: a one-row list cannot tell "the relation follows the
// selection" from "the relation is stuck on the only row there is".
const COMMANDS: SlashCommand[] = [
  { name: 'clear', description: 'Clear the conversation', source: 'builtin' },
  { name: 'compact', description: 'Summarize and restart', source: 'builtin' },
  { name: 'cost', description: 'Show token spend', source: 'builtin' },
];

const roots: Root[] = [];

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: { blocks: () => Promise.resolve([]), onBlock: () => () => {}, onReset: () => () => {} },
    pty: { input: () => {} },
    workspace: { getUi: () => Promise.resolve({}), setUi: () => {} },
    sessions: {
      slashCommands: () => Promise.resolve(COMMANDS),
      summaries: () => Promise.resolve(SESSIONS),
      resolveMentions: (_id: string, text: string) => Promise.resolve({ ok: true, prompt: text }),
      submitPrompt: () => Promise.resolve(true),
    },
  };
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

async function mount(cardId = 'card-b'): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const ctx: PanelContext = {
    sessionId: OWN_ID,
    cardId,
    title: 'Beta',
    visible: true,
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    transport: 'stream',
    controlsLock: null,
    setView: () => {},
  };
  await act(async () => {
    root.render(feedPanel.render(ctx));
  });
  return host;
}

const boxOf = (host: HTMLElement): HTMLTextAreaElement => host.querySelector('textarea')!;
const listOf = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>('[data-completion-list]');
const optionsOf = (host: HTMLElement): HTMLElement[] =>
  [...host.querySelectorAll<HTMLElement>('[data-completion-row]')];

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

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

/** The element `aria-activedescendant` actually resolves to, by the IDREF rule. */
function activeDescendant(host: HTMLElement): Element | null {
  const id = boxOf(host).getAttribute('aria-activedescendant');
  if (!id) return null;
  // `getElementById` on the DOCUMENT, not a scoped query: an IDREF resolves in
  // the document and takes the FIRST element in tree order. Scoping the lookup
  // to `host` would hide exactly the capture `FeedView.forgery.test.tsx` exists
  // to catch, and would make this helper agree with a broken implementation.
  return document.getElementById(id);
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
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
  vi.unstubAllGlobals();
});

describe('the completion popup is a listbox (#828)', () => {
  it.each([
    ['slash commands', '/c', 'slash'],
    ['session mentions', '@Tra', 'mention'],
  ])('%s: the container is a NAMED listbox of options', async (_what, typed, kind) => {
    const host = await mount();
    await type(host, typed);

    const list = listOf(host);
    expect(list, 'the popup did not open — the test asserts nothing').not.toBeNull();
    expect(list!.getAttribute('role')).toBe('listbox');
    expect(list!.dataset.completionList).toBe(kind);
    // NAMED, and named differently per list. Two cards on screen means two of
    // these in one document; "Suggestions" on both is the #196 failure one
    // level down — enumerable, indistinguishable, useless.
    expect(list!.getAttribute('aria-label')).toBeTruthy();

    const options = optionsOf(host);
    expect(options.length).toBeGreaterThan(1);
    for (const o of options) expect(o.getAttribute('role')).toBe('option');
  });

  it('the two lists do not share a name', async () => {
    const host = await mount();
    await type(host, '/c');
    const commandName = listOf(host)!.getAttribute('aria-label');
    await type(host, '@Tra');
    const sessionName = listOf(host)!.getAttribute('aria-label');
    expect(commandName).not.toBe(sessionName);
  });

  it.each([
    ['slash commands', '/c'],
    ['session mentions', '@Tra'],
  ])('%s: exactly one option is selected, and it is the highlighted one', async (_what, typed) => {
    const host = await mount();
    await type(host, typed);
    const options = optionsOf(host);
    const selected = options.filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(options[0]);
    // …and the rest say so EXPLICITLY rather than omitting the attribute.
    // ARIA 1.2's default for `aria-selected` on an option is already `false`,
    // so omitting it would be legal (corrected in review) — but AT support for
    // the default is patchier than for the attribute, and `CommandPalette`
    // writes it out for the same reason.
    for (const o of options.slice(1)) expect(o.getAttribute('aria-selected')).toBe('false');
  });
});

describe('the textarea carries the completion relations while a list is up (#828)', () => {
  it.each([
    ['slash commands', '/c'],
    ['session mentions', '@Tra'],
  ])('%s: controls the list, points at the option, and stays a textbox', async (_what, typed) => {
    const host = await mount();
    await type(host, typed);
    const box = boxOf(host);

    // NO ROLE, and that is the decision this item settled (review).
    // ARIA-in-HTML permits no `role` on `<textarea>` at all — its implicit role
    // is `textbox` — and ARIA says roles SHOULD NOT change over time, so the
    // first cut's conditional `role="combobox"` was both invalid and, on the
    // focused node, the least likely thing to be announced. ARIA 1.2's
    // `textbox` supports `aria-activedescendant` and `aria-autocomplete`
    // natively and `aria-controls` is global, so all three below are valid on
    // the element exactly as the browser already types it.
    expect(box.getAttribute('role')).toBeNull();
    expect(box.getAttribute('aria-expanded')).toBeNull();
    // Free text is always allowed — this is a suggestion list, not a value list.
    expect(box.getAttribute('aria-autocomplete')).toBe('list');
    // The relations must RESOLVE, not merely be present. An `aria-controls`
    // naming an id nothing carries is the same as no relation at all, and is
    // the failure mode a `toBeTruthy()` on the attribute would wave through.
    expect(document.getElementById(box.getAttribute('aria-controls')!)).toBe(listOf(host));
    expect(activeDescendant(host)).toBe(optionsOf(host)[0]);
  });

  it('keeps the send/newline hint in its NAME, not demoted to a description', async () => {
    // The accessible name fell through to `placeholder` before this item, which
    // works but is a browser courtesy rather than an authored name. Naming the
    // box something shorter — "Prompt this session" — would have moved
    // "Enter to send, Shift+Enter for a new line" from the name to a
    // description, which many users have switched off. Caught in review; the
    // label is now the same string, said deliberately.
    const host = await mount();
    const box = boxOf(host);
    expect(box.getAttribute('aria-label')).toBe(box.placeholder);
    expect(box.getAttribute('aria-label')).toMatch(/Shift\+Enter/);
  });

  it.each([
    ['slash commands', '/c'],
    ['session mentions', '@Tra'],
  ])('%s: announces the list opening in a polite live region', async (_what, typed) => {
    // The job `aria-expanded` could not do, because the role it needs is not
    // allowed on this element. A live region says it instead — no role on the
    // input, no ARIA-in-HTML violation, and it works the same on every AT.
    const host = await mount();
    const announce = host.querySelector<HTMLElement>('[data-completion-announce]');

    // MOUNTED EMPTY on the first frame (#222's rule for `FindBar`'s count): a
    // live region that arrives already holding its text is announced by almost
    // nothing. So this must exist before the popup does.
    expect(announce, 'the live region must be mounted before it has anything to say').not.toBeNull();
    expect(announce!.textContent).toBe('');
    expect(announce!.getAttribute('aria-live')).toBe('polite');

    await type(host, typed);
    const said = announce!.textContent ?? '';
    expect(said).not.toBe('');
    // It says the COUNT, and the count is real — a hard-coded sentence would
    // pass a `not.toBe('')` and tell the user nothing.
    expect(said).toContain(String(optionsOf(host).length));
    // It does NOT name the highlighted row: that is `aria-activedescendant`'s
    // job, and saying it here too would talk over every arrow key.
    expect(said).not.toContain('/clear');
    expect(said).not.toContain('TradingApp');
  });

  it('the two lists announce differently', async () => {
    const host = await mount();
    const announce = (): string =>
      host.querySelector<HTMLElement>('[data-completion-announce]')!.textContent ?? '';
    await type(host, '/c');
    const commands = announce();
    await type(host, '@Tra');
    expect(announce()).not.toBe(commands);
  });

  it('every relation is GONE once the list closes, not left stale', async () => {
    // A relation left behind over a closed list is worse than never having had
    // one: `aria-activedescendant` would name an element that no longer exists,
    // and `aria-controls` a list the user cannot arrow into. ALL of them are
    // checked, not a representative one — the conditional is a single spread,
    // so a refactor that drops one key out of it would pass a partial check.
    const host = await mount();
    await type(host, '/c');
    expect(boxOf(host).getAttribute('aria-activedescendant')).toBeTruthy();

    await type(host, 'not a command any more');
    expect(listOf(host)).toBeNull();
    for (const attr of ['aria-activedescendant', 'aria-controls', 'aria-autocomplete', 'role', 'aria-expanded'])
      expect(boxOf(host).getAttribute(attr), attr).toBeNull();
    // …and the live region falls silent rather than repeating itself.
    expect(host.querySelector<HTMLElement>('[data-completion-announce]')!.textContent).toBe('');
  });

  it('Escape closes the list and takes the relations with it', async () => {
    // The second route to a closed popup, and the one a keyboard user reaches
    // for. It dismisses without changing the draft, so nothing else in this
    // file's "type something else" shape would exercise it.
    const host = await mount();
    await type(host, '/c');
    expect(listOf(host)).not.toBeNull();

    await press(host, 'Escape');
    expect(listOf(host)).toBeNull();
    expect(boxOf(host).getAttribute('aria-activedescendant')).toBeNull();
    expect(host.querySelector<HTMLElement>('[data-completion-announce]')!.textContent).toBe('');
  });
});

describe('the ids are not a name the transcript can forge (#828, the #654 class)', () => {
  // WHY THIS COMPONENT IS THE LIVE ONE, which is the same argument
  // `CommandPalette.test.tsx` makes for itself and is if anything stronger
  // here: `aria-activedescendant` is an IDREF, an IDREF resolves to the FIRST
  // element in tree order carrying that id, `id` survives the sanitizer profile
  // (`ALLOW_DATA_ATTR: false` removes `data-*`, but not `id`), and the feed
  // renders assistant-authored markdown IMMEDIATELY ABOVE this composer in the
  // same document. A reply containing `<div id="completion-opt-0">rm -rf</div>`
  // would therefore be what a screen reader reads out as the highlighted
  // completion, while Enter inserts the real one. #509's harm — a lie the
  // sighted reader cannot see — reached through a name rather than an
  // attribute.
  //
  // (`markdown.test.tsx`'s source-tree scan catches a literal id coming BACK
  // into any renderer file, including this one. What it cannot see is whether
  // the refs still RESOLVE, which is what the block above asserts, or whether
  // the namespace is stable, which is this.)

  it('no completion id is a literal namespace, and none is built from content', async () => {
    // WHAT THIS PINS, said plainly because the obvious reading is stronger than
    // the truth (review): it is not "no id is guessable" — a `feed-opt-0` would
    // sail past it. It catches a LITERAL NAMESPACE coming back in the spellings
    // someone would actually reach for, which is the regression `markdown.test`'s
    // source scan cannot see (that scan matches inline `id="…"` in JSX; a
    // `const NS = 'completion-'` used as `id={\`${NS}opt-${i}\`}` passes it —
    // verified by mutation). The property that matters is the next test's.
    const host = await mount();
    await type(host, '/c');
    const ids = [...host.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id).not.toMatch(/^completion-(?:list|opt)\b/);
      // …and none of them carries the CONTENT of a row. `/clear` is a command
      // name and `live-a` a session id; both are strings a transcript knows.
      expect(id).not.toMatch(/clear|live-a/);
    }
    // The test hook is a `data-*`, which content cannot emit at all
    // (`ALLOW_DATA_ATTR: false`), so adding a findable handle did not put a
    // second guessable name back.
    expect(host.querySelector('[data-completion-list]')).not.toBeNull();
  });

  it('the ids belong to the TREE, not to this component', async () => {
    // `React.useId()` is NOT a secret — React 19 numbers client ids from a
    // module-global counter — so the honest property is this one: the strings
    // move when anything else in the tree calls `useId` first. That is what
    // makes them not-a-published-name. Same pin as `CommandPalette.test.tsx`'s.
    //
    // #673's per-launch `identifierPrefix` is what makes the composed id
    // genuinely UNGUESSABLE rather than merely unpublished, and it is NOT
    // exercised here: these roots are created without one, because the prefix
    // is applied once in `main.tsx`. `lib/root-identity.test.tsx` owns that
    // half. Said out loud so a green run here is not read as covering it.
    const host = await mount();
    await type(host, '/c');
    const before = boxOf(host).getAttribute('aria-activedescendant');
    expect(before).toBeTruthy();

    const other = await mount('card-second');
    await type(other, '/c');
    const after = boxOf(other).getAttribute('aria-activedescendant');
    expect(after).toBeTruthy();
    // Two composers in one document: if the id were derived from anything the
    // component knows about itself — the row key, the card id, a literal — both
    // would be the same string, two elements would answer to it, and the FIRST
    // in tree order would win for both. Which is the forgery, self-inflicted.
    expect(after).not.toBe(before);
    expect(document.getElementById(before!)).toBe(optionsOf(host)[0]);
    expect(document.getElementById(after!)).toBe(optionsOf(other)[0]);
  });
});

describe('arrowing the list moves what a screen reader is told (#828)', () => {
  it.each([
    ['slash commands', '/c'],
    ['session mentions', '@Tra'],
  ])('%s: ArrowDown moves the active descendant AND the selection', async (_what, typed) => {
    const host = await mount();
    await type(host, typed);
    const before = optionsOf(host);
    expect(before.length).toBeGreaterThan(1);
    expect(activeDescendant(host)).toBe(before[0]);

    await press(host, 'ArrowDown');

    const after = optionsOf(host);
    expect(activeDescendant(host)).toBe(after[1]);
    expect(after[1].getAttribute('aria-selected')).toBe('true');
    expect(after[0].getAttribute('aria-selected')).toBe('false');
  });

  it('ArrowUp from the top wraps, and the relation wraps with it', async () => {
    // The selection already wrapped before this item; what is new is that the
    // announcement has to wrap too, or the screen-reader user is told the
    // highlight went somewhere it did not.
    const host = await mount();
    await type(host, '/c');
    const options = optionsOf(host);
    await press(host, 'ArrowUp');
    expect(activeDescendant(host)).toBe(optionsOf(host)[options.length - 1]);
  });

  it('what the relation names and what is MARKED are always the same row', async () => {
    // THE INVARIANT, not a value — the first draft asserted the value and was
    // vacuous (review). It typed a narrowing filter and checked
    // `aria-activedescendant` named the surviving row; but by then the effect
    // that resets `selected` to 0 had run, so clamped and unclamped produce the
    // identical string.
    //
    // WHAT THIS DOES AND DOES NOT CATCH, because the honest answer is not the
    // flattering one. The defect review found is a DISAGREEMENT: `activeIndex`
    // is clamped, and `aria-selected`, the scroll ref and the highlight used to
    // read raw `selected`, so for one commit after a narrowing keystroke the
    // relation named row 0 while no row was marked. **That window is one commit
    // wide and closes inside the same `act()`** — mutation-verified: putting
    // `aria-selected={i === selected}` back leaves this file 20/20 green. The
    // single `activeIndex` removes the class structurally rather than under
    // test, and that is the honest claim.
    //
    // What this DOES pin is the contract at every settled point, which is what
    // a user is ever exposed to: exactly one row marked, and the relation
    // naming that row — including immediately after the list shrinks under the
    // selection, which is the state the bug was reached through.
    const host = await mount();
    const agree = (where: string): void => {
      const marked = optionsOf(host).filter((o) => o.getAttribute('aria-selected') === 'true');
      expect(marked, `${where}: exactly one row must be marked`).toHaveLength(1);
      expect(activeDescendant(host), `${where}: the relation must name the marked row`).toBe(
        marked[0]
      );
    };

    await type(host, '/c');
    agree('on open');
    await press(host, 'ArrowDown');
    agree('after ArrowDown');
    await press(host, 'ArrowDown');
    agree('at the end of the list');
    // …and now narrow it past where the selection was sitting
    await type(host, '/cl');
    expect(optionsOf(host)).toHaveLength(1);
    agree('after the list narrowed under the selection');
  });

  it('the mouse moves it too, and the relation follows the mouse', async () => {
    // Hovering a row IS choosing it — the component says so at the handler —
    // so the announcement has to move with the pointer as well as the arrows.
    // A keyboard-only assertion would leave half the selection path unpinned.
    const host = await mount();
    await type(host, '/c');
    const options = optionsOf(host);
    expect(options.length).toBeGreaterThan(2);

    await act(async () => {
      options[2].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(activeDescendant(host)).toBe(optionsOf(host)[2]);
    expect(optionsOf(host)[2].getAttribute('aria-selected')).toBe('true');
  });
});
