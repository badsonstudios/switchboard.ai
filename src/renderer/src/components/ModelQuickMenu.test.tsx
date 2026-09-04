// @vitest-environment jsdom
// The footer chip's quick-switch menu (#747).
//
// WHAT THIS FILE OWNS, and why it is not a copy of the picker's suite. The two
// surfaces share their DATA rules (`lib/model-choices.test.ts` pins those,
// once); what differs is the whole reason this exists — the COMMIT semantics.
// The dialog stages a click and waits for OK; this sends on the click. Every
// test here is about that difference and what it costs:
//
//   • one click is exactly one `set_model`, carrying the row's VALUE;
//   • a click on the model it already runs sends NOTHING — it is a dismissal,
//     not a switch, and a no-op `set_model` would make "I clicked and something
//     happened" indistinguishable from "I clicked and nothing did";
//   • a refusal has nowhere else to go, so the menu holds it — open, in the
//     CLI's own words, with nothing moved;
//   • a switch in flight HOLDS THE MENU OPEN, which is the thing that makes the
//     line above possible at all.
//
// It never asks main which model is current: the chip already knows, and the
// menu is handed the chip's own answer. A test that stubbed `currentModel` here
// would be pinning a call that must not exist.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { ModelQuickMenu } from './ModelQuickMenu';
import { CLI_MODELS as MODELS } from '../lib/fixtures/cli-models';
import { initI18nForTests } from '../i18n/test-i18n';
import type { ControlVerdict } from '../../../shared/control';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;

let listAnswer: ControlVerdict;
let setAnswer: ControlVerdict;
let calls: Array<{ channel: string; args: unknown[] }>;
/** resolves the list call by hand, so "before it lands" is a real state */
let releaseList: (() => void) | null = null;
/** …and the same for the switch, so the in-flight window is observable */
let releaseSet: (() => void) | null = null;
let closed: number;
/** every `onBusyChange` the menu reported, in order */
let busySaid: boolean[];

function installBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      listModels: (id: string) => {
        calls.push({ channel: 'listModels', args: [id] });
        return new Promise((resolve) => {
          const fire = (): void => resolve(listAnswer);
          if (releaseList === null) fire();
          else releaseList = fire;
        });
      },
      setModel: (id: string, model: string) => {
        calls.push({ channel: 'setModel', args: [id, model] });
        return new Promise((resolve) => {
          const fire = (): void => resolve(setAnswer);
          if (releaseSet === null) fire();
          else releaseSet = fire;
        });
      },
      // Present so that CALLING it would be visible rather than a TypeError
      // that some future catch swallows. Nothing here may reach it: the tick is
      // the chip's own value, handed in. See the file header.
      currentModel: (id: string) => {
        calls.push({ channel: 'currentModel', args: [id] });
        return Promise.resolve(null);
      },
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** the chip's box, as `getBoundingClientRect()` gives it */
const ANCHOR = { x: 10, y: 400, width: 90, height: 14 } as DOMRect;

async function mount(current: string | null = 'claude-haiku-4-5-20251001'): Promise<void> {
  await act(async () => {
    root.render(
      <ModelQuickMenu
        liveId="L1"
        current={current}
        anchor={ANCHOR}
        onClose={() => {
          closed += 1;
        }}
        onBusyChange={(b) => {
          busySaid.push(b);
        }}
      />
    );
  });
  await settle();
}

async function click(el: Element | null): Promise<void> {
  expect(el, 'element to click').not.toBeNull();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

const rows = (): HTMLElement[] => Array.from(host.querySelectorAll<HTMLElement>('[data-model]'));
const rowFor = (v: string): HTMLElement => host.querySelector<HTMLElement>(`[data-model="${v}"]`)!;
const text = (): string => host.textContent ?? '';
/**
 * The notice's TEXT.
 *
 * The element is always mounted — it is a live region, and one that arrives
 * already holding its words is announced by almost nothing (#222's rule) — so
 * asserting on the element's presence would be asserting on nothing at all.
 */
const noticeText = (): string => host.querySelector('[data-model-menu-notice]')?.textContent ?? '';
const menu = (): HTMLElement => host.querySelector<HTMLElement>('[data-model-menu]')!;
const sets = (): typeof calls => calls.filter((c) => c.channel === 'setModel');

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  releaseList = null;
  releaseSet = null;
  calls = [];
  closed = 0;
  busySaid = [];
  listAnswer = { ok: true, response: { models: MODELS } };
  setAnswer = { ok: true, response: {} };
  installBridge();
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('the menu', () => {
  it('lists the CLI’s own models, from the CLI’s own call', async () => {
    await mount();
    expect(calls.map((c) => c.channel)).toContain('listModels');
    expect(rows().map((r) => r.dataset.model)).toEqual(MODELS.map((m) => m.value));
    expect(text()).toContain('Default (recommended)');
  });

  it('never asks main which model is current — the chip already said', async () => {
    // The chip's value IS the tick. A second question could disagree with the
    // text the menu grew out of, and would be a round trip on the one path
    // built for speed.
    await mount();
    expect(calls.filter((c) => c.channel === 'currentModel')).toEqual([]);
  });

  it('ticks exactly ONE row on the default model — the shared-resolvedModel trap', async () => {
    // `default` and `opus[1m]` both resolve to `claude-opus-5[1m]`. Two ticked
    // rows in one radio group is invalid as well as wrong.
    await mount('claude-opus-5[1m]');
    const ticked = rows().filter((r) => r.dataset.current === 'yes');
    expect(ticked.map((r) => r.dataset.model)).toEqual(['default']);
    expect(rows().filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
  });

  it('ticks nothing, and says why, when the session has never reported a model', async () => {
    await mount(null);
    expect(rows().filter((r) => r.dataset.current === 'yes')).toEqual([]);
    expect(host.querySelector('[data-model-menu-unknown]')).not.toBeNull();
  });

  it('drops the explanation once a model IS known', async () => {
    await mount();
    expect(host.querySelector('[data-model-menu-unknown]')).toBeNull();
  });

  it('says the CLI refused rather than showing an empty menu', async () => {
    // "The CLI would not tell us" and "the CLI has no models" are different
    // facts; an empty menu with no explanation reads as a broken app.
    listAnswer = { ok: false, reason: 'refused', message: 'no models for you' };
    await mount();
    expect(rows()).toEqual([]);
    expect(noticeText()).toContain('no models for you');
  });
});

describe('one click is the whole interaction', () => {
  it('sends the model’s VALUE, not its display name, exactly once', async () => {
    await mount();
    await click(rowFor('sonnet'));
    expect(sets()).toEqual([{ channel: 'setModel', args: ['L1', 'sonnet'] }]);
  });

  it('closes on success and paints nothing — the footer is the confirmation', async () => {
    // `noteSet` pushes `sessions:model` synchronously inside the handler, so
    // the chip moves on main's answer. Anything optimistic here would be a
    // second, guessed source for a fact we are already told.
    await mount();
    await click(rowFor('sonnet'));
    expect(closed).toBe(1);
  });

  it('sends NOTHING when you click the model it already runs', async () => {
    // A dismissal, not a switch. A no-op `set_model` would make "I clicked and
    // it did something" indistinguishable from "I clicked and it did not".
    await mount('claude-haiku-4-5-20251001');
    await click(rowFor('haiku'));
    expect(sets()).toEqual([]);
    expect(closed).toBe(1);
  });

  it('holds the menu open on a refusal, in the CLI’s words, session untouched', async () => {
    const sentence = 'Model "sonnet" is not available on your plan.';
    setAnswer = { ok: false, reason: 'refused', message: sentence };
    await mount();
    await click(rowFor('sonnet'));
    expect(closed).toBe(0);
    expect(noticeText()).toBe(sentence);
    // the tick has NOT moved — nothing was applied
    expect(rows().filter((r) => r.dataset.current === 'yes').map((r) => r.dataset.model)).toEqual([
      'haiku',
    ]);
  });

  it('recovers from a rejected invoke instead of sitting on "switching…" for ever', async () => {
    // A channel failure, not a refusal verdict. Without the `.catch` the menu
    // would stay busy AND refuse to close, which is the one state worse than
    // losing the message.
    (
      window as unknown as { switchboard: { sessions: { setModel: () => Promise<never> } } }
    ).switchboard.sessions.setModel = () => Promise.reject(new Error('channel gone'));
    await mount();
    await click(rowFor('sonnet'));
    expect(noticeText()).not.toBe('');
    // EVERY row live again, not "not every row dead" — the weaker form passes
    // with four of the five still disabled.
    expect(rows().every((r) => !(r as HTMLButtonElement).disabled)).toBe(true);
    // and the composer's chip has been told it may close the menu again
    expect(busySaid).toEqual([true, false]);
  });
});

describe('a switch in flight holds the menu', () => {
  it('refuses Escape and click-away until the verdict lands', async () => {
    // THE REASON THIS EXISTS: a refusal has no dialog to print in, so the menu
    // must still be on screen when one arrives. A menu that vanished on Escape
    // would leave the session on a model the user thinks they changed.
    releaseSet = () => {};
    await mount();
    await act(async () => {
      rowFor('sonnet').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const land = releaseSet;
    expect(text()).toContain('switching');

    menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    host
      .querySelector('[data-model-menu-scrim]')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await settle();
    expect(closed).toBe(0);

    await act(async () => {
      land();
      await Promise.resolve();
    });
    expect(closed).toBe(1);
  });

  it('goes dead to a second click while the first set_model is outstanding', async () => {
    // WHAT STOPS THE SECOND SEND is `disabled` on every row — React does not
    // dispatch to a disabled form control, so the click never reaches `pick`.
    // Named that way deliberately: `pick`'s own `busy` guard is belt to this
    // one's braces and is unreachable, so a title claiming to test THAT would
    // be claiming coverage this cannot give (mutating the guard away leaves
    // this green; mutating `disabled` away turns it red).
    releaseSet = () => {};
    await mount();
    await act(async () => {
      rowFor('sonnet').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const land = releaseSet;
    expect(rows().every((r) => (r as HTMLButtonElement).disabled)).toBe(true);

    await act(async () => {
      rowFor('haiku').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(sets()).toHaveLength(1);

    await act(async () => {
      land();
      await Promise.resolve();
    });
  });
});

describe('closing sends nothing', () => {
  it('Escape closes and puts no set_model on the wire', async () => {
    await mount();
    await act(async () => {
      menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(closed).toBe(1);
    expect(sets()).toEqual([]);
  });

  it('click-away is the same door as Escape', async () => {
    await mount();
    await act(async () => {
      host
        .querySelector('[data-model-menu-scrim]')!
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(closed).toBe(1);
    expect(sets()).toEqual([]);
  });
});

describe('every door out obeys the in-flight rule', () => {
  it('tells the composer when a switch starts and when it lands', async () => {
    // The chip is the third door, and the composer owns it. Without this the
    // keyboard route — the click disables every row, Chromium blurs to <body>,
    // Tab reaches the chip, Enter — tears the menu down mid-switch and the
    // refusal lands in a torn-down tree.
    releaseSet = () => {};
    await mount();
    await act(async () => {
      rowFor('sonnet').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(busySaid).toEqual([true]);
    await act(async () => {
      releaseSet!();
      await Promise.resolve();
    });
    expect(busySaid).toEqual([true, false]);
  });

  it('says nothing about busy for a click that sends nothing', async () => {
    // Clicking the running model closes without a round trip; announcing a
    // busy window there would disable the chip for a switch that never was.
    await mount('claude-haiku-4-5-20251001');
    await click(rowFor('haiku'));
    expect(busySaid).toEqual([]);
  });
});

describe('the keyboard can walk it', () => {
  it('Tab closes it rather than leaving a scrim over everything', async () => {
    // The house rule the rail's menu already follows (APG): what must not
    // happen is the menu staying up, with its full-viewport scrim, while the
    // keyboard has moved on to controls the mouse can no longer reach.
    await mount();
    await act(async () => {
      menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(closed).toBe(1);
    expect(sets()).toEqual([]);
  });

  it('focuses the BOX when the list refused, so Escape still works', async () => {
    // A refused list never grows a row. Waiting for one would leave the
    // keyboard on the chip behind the scrim, and Escape — handled on the box —
    // would never reach it: mouse-only dismissal.
    listAnswer = { ok: false, reason: 'refused', message: 'nope' };
    await mount();
    expect(document.activeElement).toBe(menu());
    await act(async () => {
      menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(closed).toBe(1);
  });

  it('hands the keyboard back to the row that was refused', async () => {
    // Chromium blurs a focused element the moment it is disabled, so after a
    // switch the keyboard is on <body> — outside the box, where the keydown
    // handler cannot see it. jsdom does not blur, so this asserts the RECOVERY
    // (which is ours) rather than the blur (which is the browser's).
    setAnswer = { ok: false, reason: 'refused', message: 'no' };
    await mount();
    await click(rowFor('sonnet'));
    expect(document.activeElement).toBe(rowFor('sonnet'));
  });
});

describe('walking the rows', () => {
  it('gives the first row the keyboard as the list lands, and arrows down it', async () => {
    // A menu you can open with the keyboard and not walk is worse than no menu.
    await mount();
    expect(document.activeElement).toBe(rowFor('default'));
    await act(async () => {
      menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(rowFor('opus[1m]'));
  });

  it('wraps rather than stopping dead at the ends', async () => {
    await mount();
    await act(async () => {
      menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(document.activeElement).toBe(rowFor('haiku'));
  });
});
