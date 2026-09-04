// @vitest-environment jsdom
// The session footer's model chip, and when it is a CONTROL (#747).
//
// #746 made the chip tell the truth; this decides who is allowed to press it.
// The chip renders `model ?? usage?.model` — the picker's answer, with the
// transcript's as the fallback — so a **Terminal-mode session can SHOW a model
// it cannot be switched to**: `set_model` rides the control channel, which is
// stream-only. The branch here is what stops us offering a menu whose every row
// is a known refusal.
//
// Three shapes, and each of them is a claim about the session:
//
//   • stream + a model  → a button, reading the model
//   • stream, no model  → the same button, reading "model?" — the CLI only says
//     which model it runs once a session has replied, and a fresh card is
//     exactly when you want to choose before spending a turn
//   • PTY              → the plain span it has always been, tooltip pointing at
//     `/model` in the Terminal tab
//
// Rendered through the REAL panel contribution, the way the card reaches it, so
// a prop that stops being threaded from `SessionGrid` is red here. A test of the
// component in isolation would stay green through exactly that.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { sessionPanels } from '../extensibility/panels';
import { CLI_MODELS as MODELS } from '../lib/fixtures/cli-models';
import type { PanelContext } from '../extensibility/contributions';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

let host: HTMLDivElement;
let root: Root;
let calls: string[];

function installBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve([]),
      onBlock: () => () => {},
      onReset: () => () => {},
    },
    sessions: {
      slashCommands: () => Promise.resolve([]),
      listModels: () => {
        calls.push('listModels');
        return Promise.resolve({ ok: true, response: { models: MODELS } });
      },
      setModel: () => {
        calls.push('setModel');
        return Promise.resolve({ ok: true, response: {} });
      },
    },
    workspace: { getUi: () => Promise.resolve({}), setUi: () => {} },
  };
}

async function mount(over: Partial<PanelContext>): Promise<void> {
  const ctx: PanelContext = {
    sessionId: 'live-1',
    cardId: 'card-1',
    title: 'acme-web',
    visible: true,
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    setView: () => {},
    ...over,
  };
  await act(async () => {
    root.render(feedPanel.render(ctx));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const chip = (): HTMLElement | null => host.querySelector('[data-testid="composer-model"]');
const menu = (): HTMLElement | null => host.querySelector('[data-model-menu]');

/** click the chip and let the menu's own `list_models` settle */
async function tapChip(): Promise<void> {
  await act(async () => {
    chip()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  calls = [];
  installBridge();
  // jsdom has no ResizeObserver, and the feed's scroll anchor plus the
  // composer's re-measure both install one
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('a session we can switch', () => {
  it('makes the model name a button that says it opens a menu', async () => {
    await mount({ transport: 'stream', model: 'claude-sonnet-5' });
    expect(chip()?.tagName).toBe('BUTTON');
    expect(chip()?.textContent).toBe('claude-sonnet-5');
    expect(chip()?.getAttribute('aria-haspopup')).toBe('menu');
    expect(chip()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the menu on click, and asks the CLI for its list', async () => {
    await mount({ transport: 'stream', model: 'claude-sonnet-5' });
    expect(menu()).toBeNull();
    await tapChip();
    expect(menu()).not.toBeNull();
    expect(chip()?.getAttribute('aria-expanded')).toBe('true');
    expect(calls).toContain('listModels');
  });

  it('a second click on the chip closes the menu rather than reopening it', async () => {
    await mount({ transport: 'stream', model: 'claude-sonnet-5' });
    await tapChip();
    expect(menu()).not.toBeNull();
    await tapChip();
    expect(menu()).toBeNull();
  });

  it('still offers the chip before the session has ever said which model', async () => {
    // The fresh card. Nothing has replied, so `StreamModel` has no answer and
    // the transcript has none either — but this is precisely when choosing is
    // worth most, so the affordance comes before the answer does.
    await mount({ transport: 'stream' });
    expect(chip()?.tagName).toBe('BUTTON');
    expect(chip()?.textContent).toBe(en.feedView.modelUnknown);
    expect(chip()?.getAttribute('title')).toBe(en.feedView.modelHintUnknown);
  });
});

describe('a session we cannot switch', () => {
  it('leaves a Terminal-mode session’s model as plain text', async () => {
    // It can SHOW a model — `usage.model`, from the transcript — and we still
    // cannot change it. A button here would be a menu of guaranteed refusals.
    await mount({ transport: 'pty', model: 'claude-sonnet-5' });
    expect(chip()?.tagName).toBe('SPAN');
    expect(chip()?.textContent).toBe('claude-sonnet-5');
  });

  it('says where the switcher actually is, instead of failing silently', async () => {
    await mount({ transport: 'pty', model: 'claude-sonnet-5' });
    expect(chip()?.getAttribute('title')).toBe(en.feedView.modelHintTerminal);
  });

  it('shows nothing at all when there is no model to show', async () => {
    // No affordance, because there is nothing to afford: no text to correct and
    // no menu we could open. The chip is simply absent, as it was before #747.
    await mount({ transport: 'pty' });
    expect(chip()).toBeNull();
  });

  it('treats a session with no live id as unswitchable', async () => {
    // A card whose session has ended keeps rendering; `sessionId` is empty
    // there, and `set_model` needs a session to send to.
    await mount({ transport: 'stream', sessionId: '', model: 'claude-sonnet-5' });
    expect(chip()?.tagName).toBe('SPAN');
  });

  it('does not send an ENDED Direct session to a Terminal tab it never had', async () => {
    // The span branch is taken for anything that is not switchable, which is
    // more than just Terminal mode. Claiming "type /model in its Terminal tab"
    // at a stopped Direct-mode session points at a tab that does not exist for
    // it — the copy has to earn its claim, not inherit it from the branch.
    await mount({ transport: 'stream', sessionId: '', model: 'claude-sonnet-5' });
    expect(chip()?.getAttribute('title')).toBe(en.feedView.modelHintInactive);
  });
});

describe('a switch on the wire locks the chip too', () => {
  it('goes dead while the menu has a set_model outstanding, and closes nothing', async () => {
    // The chip is the third door out of the menu, and the only one the menu
    // cannot shut for itself. Left live, the keyboard route (the click disables
    // every row, focus falls to <body>, Tab reaches the chip, Enter) unmounts
    // the menu mid-switch and the CLI's refusal has nowhere to land.
    let land = (): void => {};
    (
      window as unknown as { switchboard: { sessions: { setModel: () => Promise<unknown> } } }
    ).switchboard.sessions.setModel = () =>
      new Promise((resolve) => {
        land = () => resolve({ ok: true, response: {} });
      });

    await mount({ transport: 'stream', model: 'claude-sonnet-5' });
    await tapChip();
    await act(async () => {
      host
        .querySelector<HTMLElement>('[data-model="haiku"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect((chip() as HTMLButtonElement).disabled).toBe(true);
    // …and pressing it anyway leaves the menu exactly where it is
    await act(async () => {
      chip()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(menu()).not.toBeNull();

    await act(async () => {
      land();
      await Promise.resolve();
    });
    expect(menu()).toBeNull();
  });
});
