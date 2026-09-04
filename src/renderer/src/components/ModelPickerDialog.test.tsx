// @vitest-environment jsdom
// The model picker (#721).
//
// The pure helpers carry the two rules that are easy to get wrong and invisible
// when you do:
//
//   • WHICH ROW IS TICKED. `system:init.model` reports a RESOLVED id
//     (`claude-haiku-4-5-20251001`) while the list's `value` is the alias
//     (`haiku`), so matching only `value` leaves a real session with nothing
//     ticked — always, since the CLI always resolves.
//   • NOTHING IS TICKED WHEN THE MODEL IS UNKNOWN, and that is a real state
//     rather than a missing one: the CLI reports the running model only on
//     `system:init`, once per TURN, so a session that has not replied yet has
//     genuinely never said. Ticking `default` there would be inventing the one
//     fact this pane exists to report.
//
// The mounted tests own what only a rendered dialog can answer: that a refusal
// leaves the list null rather than empty, that the CLI's own sentence reaches
// the screen, and that an answer for the session you have LEFT never paints.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { ModelPickerDialog, currentIndex, failureText, rowSubtitle } from './ModelPickerDialog';
import { initI18nForTests } from '../i18n/test-i18n';
import type { ControlVerdict } from '../../../shared/control';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;

/**
 * ALL FIVE entries from the captured payload, in order.
 *
 * The fixture used to carry three, and dropping `opus[1m]` hid a real bug:
 * `default` and `opus[1m]` SHARE a `resolvedModel`, so a per-row match ticked
 * both of them for anyone on the default model. A fixture that cannot express
 * the collision cannot catch it.
 */
const MODELS = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Default (recommended)',
    description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
  },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
];

let listAnswer: ControlVerdict;
let setAnswer: ControlVerdict;
let currentAnswer: string | null;
let calls: Array<{ channel: string; args: unknown[] }>;
/** resolves the list call by hand, so "before it lands" is a real state */
let releaseList: (() => void) | null = null;
/** …and the same for the switch, so the BUSY window is observable */
let releaseSet: (() => void) | null = null;

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
      currentModel: (id: string) => {
        calls.push({ channel: 'currentModel', args: [id] });
        return Promise.resolve(currentAnswer);
      },
    },
  };
}

async function mount(liveId: string | null = 'L1', onClose: () => void = () => {}): Promise<void> {
  await act(async () => {
    root.render(<ModelPickerDialog open onClose={onClose} liveId={liveId} />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(el: Element | null): Promise<void> {
  expect(el, 'element to click').not.toBeNull();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const rows = (): HTMLElement[] => Array.from(host.querySelectorAll<HTMLElement>('[data-model]'));
const rowFor = (v: string): HTMLElement => host.querySelector<HTMLElement>(`[data-model="${v}"]`)!;
const text = (): string => host.textContent ?? '';
const okBtn = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('[data-model-ok]')!;
const cancelBtn = (): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>('[data-model-cancel]')!;
const sets = (): typeof calls => calls.filter((c) => c.channel === 'setModel');

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  releaseList = null;
  releaseSet = null;
  calls = [];
  listAnswer = { ok: true, response: { models: MODELS } };
  setAnswer = { ok: true, response: {} };
  currentAnswer = null;
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

describe('currentIndex — exactly one row, and which', () => {
  const at = (v: string): number => MODELS.findIndex((m) => m.value === v);

  it('matches the resolved id the session actually reports', () => {
    // THE CASE THAT MATTERS. `set_model` takes `haiku`; `system:init.model`
    // comes back `claude-haiku-4-5-20251001`. Matching `value` alone would tick
    // nothing on every real session.
    expect(currentIndex(MODELS, 'claude-haiku-4-5-20251001')).toBe(at('haiku'));
  });

  it('matches the alias too, for the optimistic tick right after a switch', () => {
    expect(currentIndex(MODELS, 'haiku')).toBe(at('haiku'));
  });

  it('picks ONE row when two share a resolvedModel — the captured collision', () => {
    // `default` and `opus[1m]` both resolve to `claude-opus-5[1m]`. A per-row
    // predicate ticked both, for anyone on the default model, which is the
    // default setup.
    expect(currentIndex(MODELS, 'claude-opus-5[1m]')).toBe(at('default'));
  });

  it('prefers an EXACT alias over a row that merely resolves the same way', () => {
    // A session switched to `opus[1m]` must tick `opus[1m]`, not the `default`
    // row above it that happens to resolve identically.
    expect(currentIndex(MODELS, 'opus[1m]')).toBe(at('opus[1m]'));
  });

  it('ticks NOTHING when the model is unknown', () => {
    expect(currentIndex(MODELS, null)).toBe(-1);
  });

  it('ticks nothing for a model that is not in the list at all', () => {
    expect(currentIndex(MODELS, 'claude-sonnet-4-5-20250929')).toBe(-1);
    expect(currentIndex(MODELS, 'opus')).toBe(-1);
  });
});

describe('rowSubtitle — never empty', () => {
  it('prefers the description, falls back to the resolved id, then the value', () => {
    expect(rowSubtitle(MODELS[0])).toContain('Opus 5');
    expect(rowSubtitle(MODELS[3])).toBe('claude-sonnet-5');
    expect(rowSubtitle({ value: 'bare' })).toBe('bare');
  });
});

describe('failureText — the CLI speaks for itself', () => {
  const t = (k: string): string => k;

  it('passes a refusal through verbatim rather than rewording it', () => {
    const sentence =
      'Model "x" is not a recognized model id. Run /model to see available models.';
    expect(failureText({ ok: false, reason: 'refused', message: sentence }, t)).toBe(sentence);
  });

  it('has our own words for the failures the CLI never explains', () => {
    expect(failureText({ ok: false, reason: 'not-stream', message: '' }, t)).toBe('model.notStream');
    expect(failureText({ ok: false, reason: 'session-gone', message: '' }, t)).toBe(
      'model.sessionGone'
    );
    expect(failureText({ ok: false, reason: 'timed-out', message: '' }, t)).toBe('model.timedOut');
    expect(failureText({ ok: false, reason: 'invalid', message: '' }, t)).toBe('model.failed');
  });

  it('falls back rather than showing an empty refusal', () => {
    expect(failureText({ ok: false, reason: 'refused', message: '' }, t)).toBe('model.failed');
  });
});

describe('the list', () => {
  it('draws a row per model, with the CLI’s own labels', async () => {
    await mount();
    expect(rows().map((r) => r.dataset.model)).toEqual(MODELS.map((m) => m.value));
    expect(text()).toContain('Default (recommended)');
    expect(text()).toContain('Opus 5 with 1M context');
  });

  it('ticks the running model, matched on the RESOLVED id', async () => {
    currentAnswer = 'claude-haiku-4-5-20251001';
    await mount();
    expect(rowFor('haiku').dataset.current).toBe('yes');
    expect(rowFor('haiku').getAttribute('aria-checked')).toBe('true');
    expect(rowFor('sonnet').dataset.current).toBeUndefined();
  });

  it('says "not known yet" when the session has never reported a model', async () => {
    // The fresh-card case, and the whole reason the pane has this line: a
    // picker with nothing ticked and no explanation reads as broken rather
    // than honest.
    currentAnswer = null;
    await mount();
    expect(rows().every((r) => r.dataset.current === undefined)).toBe(true);
    expect(host.querySelector('[data-model-unknown]')).not.toBeNull();
  });

  it('ticks exactly ONE row when the session is on the default model', async () => {
    // The rendered half of the collision: `default` and `opus[1m]` both resolve
    // to this id, and a per-row match put two `aria-checked` radios in one
    // radiogroup for anyone who had never switched models.
    currentAnswer = 'claude-opus-5[1m]';
    await mount();
    expect(rows().filter((r) => r.dataset.current === 'yes').map((r) => r.dataset.model)).toEqual([
      'default',
    ]);
    expect(host.querySelectorAll('[aria-checked="true"]')).toHaveLength(1);
  });

  it('says WHICH model when the session is on one that is not listed', async () => {
    // A third state, distinct from "not known yet": a settings.json pinning a
    // dated id, or an old conversation resumed. Without it this renders exactly
    // like the fresh-card case minus the sentence that makes it honest.
    currentAnswer = 'claude-sonnet-4-5-20250929';
    await mount();
    expect(rows().some((r) => r.dataset.current === 'yes')).toBe(false);
    const note = host.querySelector('[data-model-unknown]');
    expect(note?.getAttribute('data-model-unlisted')).toBe('yes');
    expect(text()).toContain('claude-sonnet-4-5-20250929');
  });

  it('re-asks when the same session’s picker is closed and reopened', async () => {
    // The path the merged sitting effect owns, and the one whose earlier
    // two-effect version silently rendered nothing at all.
    await mount('L1');
    expect(calls.filter((c) => c.channel === 'listModels')).toHaveLength(1);
    await act(async () => {
      root.render(<ModelPickerDialog open={false} onClose={() => {}} liveId="L1" />);
    });
    await act(async () => {
      root.render(<ModelPickerDialog open onClose={() => {}} liveId="L1" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls.filter((c) => c.channel === 'listModels')).toHaveLength(2);
    expect(rows()).toHaveLength(MODELS.length);
  });

  it('drops the explanation once a model IS known', async () => {
    currentAnswer = 'claude-sonnet-5';
    await mount();
    expect(host.querySelector('[data-model-unknown]')).toBeNull();
  });

  it('says nothing to pick rather than nothing at all when the CLI refuses', async () => {
    // "The CLI would not tell us" and "the CLI has no models" are different
    // facts. An empty list with no explanation reads as a broken app.
    listAnswer = { ok: false, reason: 'timed-out', message: 'the session did not answer' };
    await mount();
    expect(rows()).toHaveLength(0);
    expect(host.querySelector('[data-model-notice]')).not.toBeNull();
  });

  it('shows the CLI’s own refusal sentence', async () => {
    listAnswer = {
      ok: false,
      reason: 'refused',
      message: 'Unsupported control request subtype: list_models',
    };
    await mount();
    expect(text()).toContain('Unsupported control request subtype');
  });

  it('explains a Terminal-mode session instead of looking broken', async () => {
    listAnswer = { ok: false, reason: 'not-stream', message: 'this session has no control channel' };
    await mount();
    expect(text()).toContain('Terminal');
  });

  it('asks nothing at all with no session', async () => {
    await mount(null);
    expect(calls).toEqual([]);
    expect(rows()).toHaveLength(0);
  });
});

describe('choosing one — select, then OK (#746)', () => {
  // The dialog used to apply on the row click and offer only a ✕ to leave by,
  // so there was no way to express "I picked this" separately from "this is
  // what it is", and no way to change your mind. Clicking now STAGES; OK is
  // the only thing that reaches the CLI; Cancel/Escape/click-away discard —
  // and reverting is free precisely because nothing was ever sent.

  it('a row click stages the choice and sends NOTHING', async () => {
    currentAnswer = 'claude-sonnet-5';
    await mount();
    await click(rowFor('haiku'));
    // THE CLAIM. Before this item the same click was already on the wire.
    expect(sets()).toHaveLength(0);
    // The radiogroup follows the click…
    expect(rowFor('haiku').dataset.selected).toBe('yes');
    expect(rowFor('sonnet').dataset.selected).toBeUndefined();
    // …while what the session is RUNNING has not moved, because it has not.
    expect(rowFor('sonnet').dataset.current).toBe('yes');
    expect(rowFor('haiku').dataset.current).toBeUndefined();
    // and it says so rather than leaving the difference to be inferred
    expect(host.querySelector('[data-model-staged]')).not.toBeNull();
  });

  it('OK sends the model’s VALUE, not its display name', async () => {
    // `set_model` takes the id. Sending "Haiku" would be refused by the CLI —
    // correctly, and confusingly.
    await mount();
    await click(rowFor('haiku'));
    await click(okBtn());
    expect(sets()).toHaveLength(1);
    expect(sets()[0].args).toEqual(['L1', 'haiku']);
  });

  it('OK closes on success — the close is the confirmation', async () => {
    const onClose = vi.fn();
    await mount('L1', onClose);
    await click(rowFor('haiku'));
    expect(onClose).not.toHaveBeenCalled();
    await click(okBtn());
    expect(onClose).toHaveBeenCalled();
  });

  it('Cancel discards the selection and sends nothing', async () => {
    const onClose = vi.fn();
    await mount('L1', onClose);
    await click(rowFor('haiku'));
    await click(cancelBtn());
    expect(sets()).toHaveLength(0);
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape and click-away are the same door as Cancel', async () => {
    // Three ways out, one behaviour — the dialog-shape convention this pane
    // inherits. A Cancel that sent nothing while Escape sent something would
    // be the worst possible version of commit semantics.
    const onClose = vi.fn();
    await mount('L1', onClose);
    await click(rowFor('haiku'));
    await act(async () => {
      host
        .querySelector('[data-testid="model-picker"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(sets()).toHaveLength(0);
    expect(onClose).toHaveBeenCalled();

    onClose.mockClear();
    await mount('L1', onClose);
    await click(rowFor('haiku'));
    await act(async () => {
      // the scrim, not the dialog — `onMouseDown` on the backdrop
      (host.firstElementChild as HTMLElement).dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true })
      );
    });
    expect(sets()).toHaveLength(0);
    expect(onClose).toHaveBeenCalled();
  });

  it('a refusal keeps the dialog open, in the CLI’s words, session untouched', async () => {
    const onClose = vi.fn();
    currentAnswer = 'claude-sonnet-5';
    setAnswer = {
      ok: false,
      reason: 'refused',
      message: 'Model "haiku" is not a recognized model id. Run /model to see available models.',
    };
    await mount('L1', onClose);
    await click(rowFor('haiku'));
    await click(okBtn());
    expect(text()).toContain('is not a recognized model id');
    // It stays open, so try-again / pick-another / Cancel are all still in
    // front of the user rather than behind a reopen.
    expect(onClose).not.toHaveBeenCalled();
    expect(rowFor('sonnet').dataset.current).toBe('yes'); // unchanged
    expect(rowFor('haiku').dataset.current).toBeUndefined();
    // and the selection survives, so OK is one press away
    expect(rowFor('haiku').dataset.selected).toBe('yes');
  });

  it('OK is dead until the selection would actually change something', async () => {
    // A no-op `set_model` would make "I pressed OK and nothing happened"
    // ambiguous between "it worked" and "it did not".
    currentAnswer = 'claude-sonnet-5';
    await mount();
    expect(okBtn().disabled).toBe(true); // nothing chosen yet
    await click(rowFor('sonnet')); // …the one it is already running
    expect(okBtn().disabled).toBe(true);
    await click(rowFor('haiku'));
    expect(okBtn().disabled).toBe(false);
  });

  it('never fires twice while a switch is in flight', async () => {
    // Staging narrows this window — one button rather than five rows — but it
    // does not close it: OK can be pressed, Escape pressed before it lands,
    // the dialog reopened, and OK pressed again. The CLI would apply both and
    // the last to land wins, which is not necessarily the one chosen last.
    releaseSet = () => {};
    await mount();
    await click(rowFor('haiku'));
    await act(async () => {
      okBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const land = releaseSet;
    expect(rows().every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
    expect(okBtn().disabled).toBe(true);
    expect(text()).toContain('switching');

    await act(async () => {
      okBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(sets()).toHaveLength(1);

    await act(async () => {
      land();
      await Promise.resolve();
    });
  });
});

describe('an answer for the session you have left never paints', () => {
  it('discards a list that arrives after the session changed', async () => {
    // A `list_models` is allowed ten seconds and the dialog is closable
    // throughout, so an answer aimed at one session can land while another is
    // on screen. `McpManagerDialog` reproduced this exact shape in review.
    releaseList = () => {};
    await mount('L1');
    const landL1 = releaseList; // still pending

    releaseList = null;
    listAnswer = { ok: true, response: { models: [{ value: 'only-l2' }] } };
    await act(async () => {
      root.render(<ModelPickerDialog open onClose={() => {}} liveId="L2" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // now L1's answer finally lands
    listAnswer = { ok: true, response: { models: MODELS } };
    await act(async () => {
      landL1();
      await Promise.resolve();
    });

    expect(rows().map((r) => r.dataset.model)).toEqual(['only-l2']);
  });

  it('a verdict for the session you have left cannot close the one you are on', async () => {
    // The epoch guard in `apply` used to protect only a NOTICE. Under commit
    // semantics it also guards `setCurrent` and `close()` — so if it regressed,
    // a late verdict for L1 would shut a dialog the user has since reopened for
    // L2 and yank focus to a stale element. The old version of this test
    // mounted, set `open={false}` and asserted no notice: with the component
    // returning `null` when shut, and the success notice gone, it could no
    // longer fail for the reason it named.
    releaseSet = () => {};
    const onClose = vi.fn();
    await mount('L1', onClose);
    await click(rowFor('haiku'));
    await act(async () => {
      okBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const landL1 = releaseSet; // L1's set_model, still outstanding
    expect(onClose).not.toHaveBeenCalled();

    // …the user leaves, and opens the picker on a different session
    releaseSet = null;
    const onCloseL2 = vi.fn();
    await act(async () => {
      root.render(<ModelPickerDialog open onClose={onCloseL2} liveId="L2" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await click(rowFor('sonnet'));

    // now L1's answer finally lands
    await act(async () => {
      landL1();
      await Promise.resolve();
    });

    // Asserted on L1's OWN spy, not L2's, and that distinction is the test:
    // `close()` is created during the L1 render and closes over the `onClose`
    // it had then, so a late verdict escaping the guard calls THAT one — and
    // an assertion aimed at `onCloseL2` would sit there passing for ever while
    // the dialog closed underneath the user.
    expect(onClose).not.toHaveBeenCalled();
    expect(onCloseL2).not.toHaveBeenCalled();
    // …and `setCurrent` must not have run either: the tick belongs to L2 now.
    expect(rowFor('haiku').dataset.current).toBeUndefined();
    expect(rowFor('sonnet').dataset.selected).toBe('yes');
    expect(host.querySelector('[data-model-notice]')).toBeNull();
  });
});

describe('the tick, the plan, and the two-rows-one-resolvedModel trap (#746)', () => {
  it('names what is STILL RUNNING once the tick has moved to a plan', async () => {
    // Staging moves the ✓, the fill and `aria-checked` onto the clicked row —
    // right, because a radio expresses selection. But that left the running
    // model with no representation at all, visual or assistive: while running
    // Sonnet and staging Haiku, Sonnet was indistinguishable from a model you
    // had never touched.
    currentAnswer = 'claude-sonnet-5';
    await mount();
    // nothing is staged, so the running row IS the ticked row and says nothing
    expect(host.querySelector('[data-model-running]')).toBeNull();

    await click(rowFor('haiku'));
    const running = host.querySelector<HTMLElement>('[data-model-running]');
    expect(running).not.toBeNull();
    expect(rowFor('sonnet').contains(running)).toBe(true); // on the RUNNING row
    // …and the sentence names it, for a reader who never lands on the row
    expect(text()).toContain('Still running');
  });

  it('OK is VISIBLY dead while a previous sitting’s switch is still outstanding', async () => {
    // The guard that stops a second `set_model` is a ref, which render cannot
    // see. So the button looked enabled and silently ate the click — the worst
    // version of a guard: it works, and the user cannot tell.
    releaseSet = () => {};
    await mount();
    await click(rowFor('haiku'));
    await act(async () => {
      okBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const land = releaseSet;

    // leave and come back — a new sitting, with the request still on the wire
    await act(async () => {
      root.render(<ModelPickerDialog open={false} onClose={() => {}} liveId="L1" />);
    });
    await mount();
    await click(rowFor('sonnet')); // a real selection, so `dirty` is not what disables it
    expect(okBtn().disabled).toBe(true);
    expect(sets()).toHaveLength(1);

    // …and it comes back to life once the outstanding one lands
    await act(async () => {
      land();
      await Promise.resolve();
    });
    await click(rowFor('sonnet'));
    expect(okBtn().disabled).toBe(false);
  });

  it('OK stays live for a row that only SHARES a resolvedModel with the current one', async () => {
    // `default` and `opus[1m]` both resolve to `claude-opus-5[1m]` in the real
    // payload. A session on that resolved id ticks `default` (the fallback
    // branch of `currentIndex`), so staging `opus[1m]` is a different ROW.
    //
    // Deliberately ENABLED. Pinning the alias is a real intent — it stops the
    // session tracking whatever `default` becomes later — even though the CLI
    // is on that model already. The alternative reading, that OK should go dead
    // because "nothing changes", would make the alias unpickable.
    currentAnswer = 'claude-opus-5[1m]';
    await mount();
    expect(rowFor('default').dataset.current).toBe('yes');
    expect(rowFor('opus[1m]').dataset.current).toBeUndefined();

    await click(rowFor('opus[1m]'));
    expect(okBtn().disabled).toBe(false);
    await click(okBtn());
    expect(sets()[0].args).toEqual(['L1', 'opus[1m]']);
  });
});
