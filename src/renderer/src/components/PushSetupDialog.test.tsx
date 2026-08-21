// @vitest-environment jsdom
// The phone-push / webhook setup dialog (P2-E14-06, §5.29).
//
// What is worth pinning here is not the layout — it is the promises the dialog
// makes about credentials:
//
//  • a stored value is NEVER rendered: the fields open empty and read "saved";
//  • the typed value leaves component state the moment it is handed over;
//  • a machine with no credential store says so and disables everything, rather
//    than accepting a token it cannot keep;
//  • the app works with none of it configured — which here means the dialog
//    renders and behaves with a bridge that answered nothing at all.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../i18n/locales/en.json';
import { PushSetupDialog } from './PushSetupDialog';
import { unavailablePushConfig } from '../../../shared/push';
import type { PushConfig } from '../../../shared/push';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
const TOPIC = 'topic-9f3a-SECRET';

const handlers = {
  onClose: vi.fn(),
  onSetPrefs: vi.fn(),
  onSetSecret: vi.fn(),
  onTest: vi.fn(async () => ({ ok: true })),
};

function config(over: Partial<PushConfig> = {}): PushConfig {
  return {
    prefs: { push: false, service: 'ntfy', webhook: false },
    secrets: {
      'ntfy.topic': false,
      'pushover.token': false,
      'pushover.user': false,
      'webhook.url': false,
    },
    storeAvailable: true,
    ...over,
  };
}

async function render(
  open: boolean,
  cfg: PushConfig | null = config(),
  write: { key: string; problem: string } | null = null
): Promise<void> {
  await act(async () => {
    root!.render(<PushSetupDialog open={open} config={cfg} write={write} {...handlers} />);
  });
}

const dialog = (): HTMLElement | null => host.querySelector<HTMLElement>('[role="dialog"]');
const field = (name: string): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>(`[data-push-field="${name}"]`);
const statusOf = (key: string): string =>
  host.querySelector<HTMLElement>(`[data-push-status="${key}"]`)?.textContent ?? '';
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found;
}
async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const h of Object.values(handlers)) h.mockReset();
  handlers.onTest.mockImplementation(async () => ({ ok: true }));
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

describe('the setup dialog', () => {
  it('renders nothing when closed', async () => {
    await render(false);
    expect(dialog()).toBeNull();
  });

  it('opens with the ntfy fields and both switches off', async () => {
    await render(true);
    expect(dialog()).not.toBeNull();
    expect(field('ntfy.topic')).not.toBeNull();
    expect(field('pushover.token')).toBeNull(); // the other service is not shown
    expect(field('enable-push')?.checked).toBe(false);
    expect(field('enable-webhook')?.checked).toBe(false);
  });

  // Two different states, deliberately: `null` is the frame before main
  // answers, and `unavailablePushConfig()` is what App sends when there is no
  // bridge to ask. Rendering the second as a live empty form would give the
  // user a Save button that silently does nothing (review finding).
  it('renders while it waits for main, without claiming anything', async () => {
    await render(true, null);
    expect(dialog()).not.toBeNull();
    expect(field('enable-push')?.checked).toBe(false);
  });

  it('a bridge that cannot answer renders as UNREACHABLE, not as a working form', async () => {
    await render(true, unavailablePushConfig());
    expect(host.textContent).toContain(en.push.unavailable);
    expect(field('ntfy.topic')?.disabled).toBe(true);
    expect(field('enable-push')?.disabled).toBe(true);
  });

  it('shows the picked service`s fields, and switches them', async () => {
    await render(true, config({ prefs: { push: false, service: 'pushover', webhook: false } }));
    expect(field('pushover.token')).not.toBeNull();
    expect(field('pushover.user')).not.toBeNull();
    expect(field('ntfy.topic')).toBeNull();
    await click(field('service.ntfy')!);
    expect(handlers.onSetPrefs).toHaveBeenCalledWith({ service: 'ntfy' });
  });
});

describe('credentials', () => {
  it('hands the typed value over and forgets it immediately', async () => {
    await render(true);
    const input = field('ntfy.topic')!;
    await type(input, TOPIC);
    await click(button(en.push.save));
    expect(handlers.onSetSecret).toHaveBeenCalledWith('ntfy.topic', TOPIC);
    // the box is empty again — the renderer keeps no second copy
    expect(input.value).toBe('');
  });

  it('never renders a stored value: a set slot reads "saved" and the box is empty', async () => {
    await render(
      true,
      config({
        secrets: {
          'ntfy.topic': true,
          'pushover.token': false,
          'pushover.user': false,
          'webhook.url': false,
        },
      })
    );
    expect(statusOf('ntfy.topic')).toBe(en.push.set);
    expect(field('ntfy.topic')?.value).toBe('');
    expect(host.innerHTML).not.toContain(TOPIC);
  });

  it('uses a password field — this gets set up on shared screens', async () => {
    await render(true);
    expect(field('ntfy.topic')?.type).toBe('password');
    expect(field('webhook.url')?.type).toBe('password');
  });

  it('does not send an empty save', async () => {
    await render(true);
    await click(button(en.push.save));
    expect(handlers.onSetSecret).not.toHaveBeenCalled();
  });

  it('offers Forget only for a slot that has something in it', async () => {
    await render(true);
    expect(() => button(en.push.forget)).toThrow();
    await render(
      true,
      config({
        secrets: {
          'ntfy.topic': true,
          'pushover.token': false,
          'pushover.user': false,
          'webhook.url': false,
        },
      })
    );
    await click(button(en.push.forget));
    expect(handlers.onSetSecret).toHaveBeenCalledWith('ntfy.topic', '');
  });

  it('re-opening clears a half-typed value rather than leaving it on screen', async () => {
    await render(true);
    await type(field('ntfy.topic')!, 'half-typed');
    await render(false);
    await render(true);
    expect(field('ntfy.topic')?.value).toBe('');
  });
});

describe('a write main refused', () => {
  // The dialog can never read a credential back, so a refusal it did not
  // render would leave an empty box and no idea whether the paste landed.
  it('says so, beside the field it was aimed at', async () => {
    await render(true, config(), { key: 'webhook.url', problem: 'bad-url' });
    const note = host.querySelector('[data-push-problem="webhook.url"]');
    expect(note?.textContent).toBe(en.push.problem['bad-url']);
    // …and not beside any other field
    expect(host.querySelector('[data-push-problem="ntfy.topic"]')).toBeNull();
  });

  it('names the credential store when that is what refused', async () => {
    await render(true, config(), { key: 'ntfy.topic', problem: 'not-stored' });
    expect(host.querySelector('[data-push-problem="ntfy.topic"]')?.textContent).toBe(
      en.push.problem['not-stored']
    );
  });

  it('says it for the server field too, which is not a credential', async () => {
    await render(true, config(), { key: 'ntfyServer', problem: 'bad-url' });
    expect(host.querySelector('[data-push-problem="ntfyServer"]')).not.toBeNull();
  });
});

describe('a machine with no credential store', () => {
  it('says so, and refuses to take anything', async () => {
    await render(true, config({ storeAvailable: false }));
    expect(host.textContent).toContain(en.push.unavailable);
    expect(field('ntfy.topic')?.disabled).toBe(true);
    expect(field('enable-push')?.disabled).toBe(true);
  });
});

describe('Send test', () => {
  it('reports success', async () => {
    await render(true);
    await click(button(en.push.sendTest));
    expect(handlers.onTest).toHaveBeenCalledWith('push');
    expect(host.querySelector('[data-push-result="push"]')?.textContent).toBe(en.push.testOk);
  });

  it('reports a failure in words, per reason', async () => {
    handlers.onTest.mockImplementation(async () => ({ ok: false, reason: 'not-configured' }));
    await render(true);
    await click(button(en.push.sendTest));
    expect(host.querySelector('[data-push-result="push"]')?.textContent).toContain(
      en.push.reason['not-configured']
    );
  });

  // The service's own complaint beats our generic sentence when you are trying
  // to get set up. It is scrubbed of every stored credential in main.
  it('shows what the service actually said, when it said anything', async () => {
    handlers.onTest.mockImplementation(async () => ({
      ok: false,
      reason: 'refused',
      detail: 'HTTP 400 application token is invalid',
    }));
    await render(true);
    await click(button(en.push.sendTest));
    expect(host.querySelector('[data-push-result="push"]')?.textContent).toContain(
      'application token is invalid'
    );
  });

  // A control that disables itself under the cursor strands focus on <body>,
  // and from there Escape reaches nothing — the key handler lives on the
  // dialog. The e2e caught this; this is the cheap pin.
  it('keeps focus inside the dialog when the button disables itself', async () => {
    await render(true);
    const send = button(en.push.sendTest);
    send.focus();
    (document.activeElement as HTMLElement).blur(); // jsdom does not blur a disabling control; do what a browser does
    await click(send);
    expect(document.activeElement).not.toBe(document.body);
    expect(dialog()!.contains(document.activeElement)).toBe(true);
  });

  it('a rejected call is a failure, not an unhandled rejection', async () => {
    handlers.onTest.mockImplementation(() => Promise.reject(new Error('bridge gone')));
    await render(true);
    await click(button(en.push.sendTest));
    expect(host.querySelector('[data-push-result="push"]')).not.toBeNull();
  });
});

describe('the switches', () => {
  it('write straight through — main is the authority on what it stored', async () => {
    await render(true);
    await act(async () => {
      field('enable-push')!.click();
    });
    expect(handlers.onSetPrefs).toHaveBeenCalledWith({ push: true });
    await act(async () => {
      field('enable-webhook')!.click();
    });
    expect(handlers.onSetPrefs).toHaveBeenCalledWith({ webhook: true });
  });
});

describe('the modal contract it shares with About', () => {
  it('closes on Escape', async () => {
    await render(true);
    await act(async () => {
      dialog()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('closes on a click outside, and not on a click inside', async () => {
    await render(true);
    await act(async () => {
      dialog()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(handlers.onClose).not.toHaveBeenCalled();
    await act(async () => {
      host
        .querySelector('div')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('is labelled, so a screen reader announces what opened', async () => {
    await render(true);
    expect(dialog()?.getAttribute('aria-label')).toBe(en.push.title);
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
  });

  it('its fields carry no id rendered content could name (#654)', async () => {
    // These fields were `id="push-field-ntfy.topic"` and friends: LITERAL,
    // stable, and therefore a NAME a document or a reply could address. `id`
    // survives the markdown sanitizer profile, and every IDREF in the DOM
    // resolves to the FIRST element in tree order carrying that id. Verified in
    // Chromium 149 with the forgery placed first: a planted
    // `<span id="push-field-ntfy.topic">` took THIS label away from THIS field
    // (`label.control` → `null`, `input.labels` → empty), so the credential box
    // lost its accessible name; and a `<label for>` in a reply both forwarded a
    // click to the field and joined the field's announced name. `markdown.tsx`
    // forbids the `<label>` TAG for the second half; this is the first.
    //
    // "PLACED FIRST" IS A CONDITION THIS DIALOG ALREADY MET: `App.tsx` renders
    // it BEFORE `SessionGrid`, so feed and viewer content is always later and
    // never captured these ids. This is prophylaxis against a reorder, not the
    // fix for a live capture — `CommandPalette` is the one that was live.
    //
    // WHAT THIS BUYS, AND WHAT IT DOES NOT, stated exactly because the first
    // draft of this test asserted more than `useId` delivers and went red
    // saying so. `React.useId()` is NOT random and it is NOT a secret: it is
    // DETERMINISTIC for a given render tree, so re-rendering the same dialog in
    // the same place gives the same string back. What it removes is a STABLE,
    // PUBLISHED name — `push-field-ntfy.topic` is the same string in every
    // build and every workspace, and it is written down in an issue — and
    // replaces it with one that is a property of THE WHOLE TREE: it moves when
    // anything else in the app calls `useId` first, which depends on which
    // panels are open and how many sessions are running. So this is
    // defence-in-depth, not the closure. THE CLOSURE IS THE TAG: `markdown.tsx`
    // forbids `<label>`, and that does not depend on a name at all.
    //
    // The rule is scanned across the whole renderer in `markdown.test.tsx`.
    // What is here is the RUNTIME half, and the label assertion is the one that
    // matters most: an id nobody publishes is worthless if the label stopped
    // pointing at the field.
    await render(true);
    const ids = [...host.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).not.toMatch(/push-field-/);

    // the label still binds — `useId` changed the string, not the wiring
    const topic = field('ntfy.topic')!;
    expect(topic.labels?.length).toBe(1);
    expect(topic.labels?.[0]?.textContent).toContain(en.push.ntfyTopic);

    // …and the string belongs to the TREE, not to this component: one more
    // `useId` caller mounted ahead of it and every id in the dialog moves.
    // That is the property that makes it not-a-published-name, and it is the
    // most this can honestly claim.
    const Ahead = (): React.JSX.Element => <i data-ahead={React.useId()} />;
    await act(async () => {
      root!.render(
        <>
          <Ahead />
          <PushSetupDialog open config={config()} write={null} {...handlers} />
        </>
      );
    });
    const shifted = [...host.querySelectorAll('[id]')].map((el) => el.id);
    expect(shifted.length).toBe(ids.length);
    expect(shifted.filter((id) => ids.includes(id))).toEqual([]);
  });
});
