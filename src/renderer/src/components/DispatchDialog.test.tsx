// @vitest-environment jsdom
// §5.15's dispatch dialog (P2-E13-03, #948).
//
// What only a RENDERED dialog can answer, and each of these is the reason the
// dialog exists rather than a bare `Dispatch → <template>` menu:
//
//  * THE TASK LINE IS PREFILLED AND EDITABLE, and a cleared one is sent as empty
//    rather than silently falling back to the transcript's `"do it."` — which is
//    the measured value for any session started from a slash command (#947).
//  * A REFUSED TEMPLATE IS SHOWN, SELECTABLE AND EXPLAINED, not hidden and not
//    `disabled` — a disabled row cannot be focused, so a keyboard user could never
//    reach the row that explains itself.
//  * A PREPARE REFUSAL LANDS IN THE DIALOG, which stays open. The alternative is a
//    Dispatch button that closes and produces nothing.
//  * CANCEL, ESCAPE AND THE SCRIM COMMIT NOTHING.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { DispatchDialog } from './DispatchDialog';
import { initI18nForTests } from '../i18n/test-i18n';
import type {
  DispatchOptions,
  DispatchPrepared,
  DispatchTemplateDto,
} from '../../../shared/dispatch-wire';
import en from '../../../shared/i18n/locales/en.json';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;
let cancelled: number;
/** Exactly what the dialog sent — the OPTIONAL fields matter, not just their values. */
let prepares: Array<{ templateId: string; taskStatement?: string; acceptanceCriteria?: string }>;
let dispatched: Array<DispatchPrepared & { ok: true }>;
/** what the next `prepare` answers; the default is a success */
let answer: DispatchPrepared;

const reviewer: DispatchTemplateDto = {
  id: 'builtin:code-reviewer',
  name: 'Code Reviewer',
  contextPolicy: 'clean-room',
  workspacePolicy: 'same-folder',
  autonomy: 'plan',
  builtIn: true,
};
const mine: DispatchTemplateDto = {
  id: 'mine-1',
  name: 'Security review',
  contextPolicy: 'briefed',
  workspacePolicy: 'same-folder',
  autonomy: 'ask',
  builtIn: false,
};
const refused: DispatchTemplateDto = {
  id: 'mine-2',
  name: 'Continuation',
  contextPolicy: 'full',
  workspacePolicy: 'same-folder',
  autonomy: 'ask',
  builtIn: false,
  refusalKey: 'dispatch.refusal.fullContext',
};

const OPTIONS: DispatchOptions = {
  templates: [reviewer, mine],
  taskStatement: 'do it.',
};

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  cancelled = 0;
  prepares = [];
  dispatched = [];
  answer = { ok: true, dispatchId: 'd-1', folder: 'C:/Projects/App', templateName: 'Code Reviewer' };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function mount(
  options: DispatchOptions = OPTIONS,
  initialTemplateId?: string
): Promise<void> {
  await act(async () => {
    root.render(
      <DispatchDialog
        fromName="TradingApp"
        options={options}
        {...(initialTemplateId === undefined ? {} : { initialTemplateId })}
        onCancel={() => {
          cancelled++;
        }}
        onPrepare={async (req) => {
          prepares.push(req);
          return answer;
        }}
        onDispatch={(p) => dispatched.push(p)}
      />
    );
  });
}

const rows = (): HTMLElement[] =>
  [...host.querySelectorAll('[data-dispatch-template]')] as HTMLElement[];
const row = (id: string): HTMLElement => host.querySelector(`[data-dispatch-template="${id}"]`)!;
const selected = (): string | null =>
  host.querySelector('[data-selected="yes"]')?.getAttribute('data-dispatch-template') ?? null;
const byTestId = <T extends HTMLElement>(id: string): T =>
  host.querySelector(`[data-testid="${id}"]`) as T;
/** A TEXTAREA since review — an `<input type="text">` strips CR/LF from its value. */
const task = (): HTMLTextAreaElement => byTestId<HTMLTextAreaElement>('dispatch-task');
const criteria = (): HTMLTextAreaElement => byTestId<HTMLTextAreaElement>('dispatch-criteria');
const go = (): HTMLButtonElement => byTestId<HTMLButtonElement>('dispatch-go');

const click = async (el: Element): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
/**
 * Type into a CONTROLLED field, the way the rest of this suite does.
 *
 * Assigning `.value` is not enough: React tracks the last value it wrote on the
 * node and skips its synthetic change event when the property is set behind its
 * back, so the component never hears the edit and the test asserts against state
 * nobody changed. Going through the prototype's own setter is what makes React's
 * tracker see a new value — the same idiom `McpManagerDialog.test.tsx` and
 * `SessionHistoryDialog.test.tsx` use.
 */
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  await act(async () => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('the roles on offer', () => {
  it('shows one row per template, in the order main gave them', async () => {
    await mount();
    expect(rows().map((r) => r.getAttribute('data-dispatch-template'))).toEqual([
      'builtin:code-reviewer',
      'mine-1',
    ]);
  });

  it('opens on the first DISPATCHABLE role, not simply the first', async () => {
    await mount({ templates: [refused, mine] });
    // Opening on a refused row would mean a dialog whose Dispatch button is dead
    // before the user has touched anything.
    expect(selected()).toBe('mine-1');
  });

  it('honours a named role even when it is refused — the user said which one', async () => {
    await mount({ templates: [reviewer, refused] }, 'mine-2');
    expect(selected()).toBe('mine-2');
    // …and seeing WHY it cannot run is the answer to having asked for it.
    expect(host.textContent).toContain(en.dispatch.refusal.fullContext);
  });

  it('⚠️ SHOWS A REFUSED ROW, SELECTABLE, rather than hiding or disabling it', async () => {
    await mount({ templates: [reviewer, refused] });
    const el = row('mine-2');
    expect(el.getAttribute('data-dispatch-refused')).toBe('yes');
    // NOT `disabled`: a disabled button cannot take focus, so a keyboard user could
    // never reach the row that explains itself — and the explanation is the whole
    // value of showing it.
    expect((el as HTMLButtonElement).disabled).toBe(false);
    await click(el);
    expect(selected()).toBe('mine-2');
  });

  it('refuses to dispatch the refused row, and says why on the button', async () => {
    await mount({ templates: [refused] });
    expect(go().disabled).toBe(true);
    expect(go().getAttribute('title')).toBe(en.dispatch.refusal.fullContext);
    await click(go());
    expect(prepares).toEqual([]);
  });

  it('renders a template NAME as data, and marks the built-ins', async () => {
    await mount();
    // #946: a built-in's name is "DATA that happens to be words". Translating it
    // would show the catalogue key for a user template called anything at all.
    expect(row('mine-1').textContent).toContain('Security review');
    expect(row('builtin:code-reviewer').textContent).toContain(en.dispatch.builtInMark);
    expect(row('mine-1').textContent).not.toContain(en.dispatch.builtInMark);
  });

  it('says what each role hands over, and what it will run at', async () => {
    await mount();
    // The autonomy is on the row because nobody watching would otherwise learn
    // that a reviewer runs under Claude Code's own write block.
    expect(row('builtin:code-reviewer').textContent).toContain(en.dispatch.policy['clean-room']);
    expect(row('builtin:code-reviewer').textContent).toContain(en.autonomy.plan);
    expect(row('mine-1').textContent).toContain(en.dispatch.policy.briefed);
  });
});

describe('the workspace policy — declared on the row, refused at the button (#949)', () => {
  /** A template that wants an isolated checkout Phase 3 has not built. */
  const worktree: DispatchTemplateDto = {
    id: 'mine-3',
    name: 'Isolated reviewer',
    contextPolicy: 'clean-room',
    workspacePolicy: 'fresh-worktree',
    autonomy: 'plan',
    builtIn: false,
    refusalKey: 'dispatch.refusal.freshWorktree',
  };

  it('names WHERE each role runs, not only what it is handed', async () => {
    await mount();
    // §5.15 gives a template two policies and until #949 the row showed one, so
    // the policy that actually ships — and the one with the consequence worth
    // knowing — was invisible.
    expect(row('builtin:code-reviewer').textContent).toContain(
      en.dispatch.workspace['same-folder']
    );
  });

  it('⚠️ DECLARES the policy it is about to refuse, on the same row', async () => {
    await mount({ templates: [reviewer, worktree] }, 'mine-3');
    const el = row('mine-3');
    // Both halves, together: what it asked for, and why it cannot have it. A red
    // sentence refusing a worktree the row never said it wanted is a refusal the
    // user cannot connect to anything.
    expect(el.textContent).toContain(en.dispatch.workspace['fresh-worktree']);
    expect(el.textContent).toContain(en.dispatch.refusal.freshWorktree);
    expect(go().disabled).toBe(true);
    await click(go());
    expect(prepares).toEqual([]);
  });

  it('says which folder the new session will work in', async () => {
    await mount({ ...OPTIONS, folder: 'C:/Projects/TradingApp' });
    expect(byTestId('dispatch-runs-in').textContent).toContain('C:/Projects/TradingApp');
  });

  it('says nothing about a folder when main could not resolve one', async () => {
    // `dispatch:options` never refuses — a bad session id costs the task default
    // and this line, and must not hide three built-in roles.
    await mount();
    expect(byTestId('dispatch-runs-in')).toBeNull();
  });

  it('⚠️ DOES NOT NAME A FOLDER FOR A ROLE THAT WOULD NOT RUN IN ONE', async () => {
    await mount({ ...OPTIONS, templates: [reviewer, worktree], folder: 'C:/Projects/TradingApp' });
    expect(byTestId('dispatch-runs-in')).not.toBeNull();
    await click(row('mine-3'));
    // The refusal on the row says this role is not getting a workspace.
    // Printing the author's folder under it would contradict it.
    expect(byTestId('dispatch-runs-in')).toBeNull();
  });

  it('⚠️ …INCLUDING A ROLE REFUSED FOR A REASON THAT IS NOT THE WORKSPACE', async () => {
    // Found in review, and it is the case the first version got wrong: the
    // `full`-with-the-fork-flag-off row has a perfectly good `same-folder`
    // policy, so a workspace-only predicate printed "Runs in C:/…" directly
    // under a red sentence saying it could not be dispatched at all. A
    // statement about where something runs is only true of something that runs.
    await mount({ ...OPTIONS, templates: [reviewer, refused], folder: 'C:/Projects/TradingApp' });
    expect(byTestId('dispatch-runs-in')).not.toBeNull();
    await click(row('mine-2'));
    expect(go().disabled).toBe(true);
    expect(byTestId('dispatch-runs-in')).toBeNull();
  });
});

describe('the task line — the reason this dialog exists', () => {
  it('⚠️ IS PREFILLED WITH WHAT THE TRANSCRIPT SAID, warts and all', async () => {
    await mount();
    // `"do it."` is the MEASURED value for a session started from a slash command
    // (#947, against this repo's own 7.7 MB transcript). Showing it is the point:
    // it is only useless once you can see it.
    expect(task().value).toBe('do it.');
  });

  it('sends what the user typed instead', async () => {
    await mount();
    await type(task(), 'Make the session rail keyboard-navigable.');
    await click(go());
    expect(prepares).toEqual([
      {
        templateId: 'builtin:code-reviewer',
        taskStatement: 'Make the session rail keyboard-navigable.',
        acceptanceCriteria: '',
      },
    ]);
  });

  it('⚠️ IS OFFERED ONLY FOR THE POLICY THAT READS IT', async () => {
    // Found in review, and it was a FALSE PROMISE rather than a cosmetic slip:
    // `dispatch-context.ts`'s `context-package` branch reads neither field — #766's
    // package derives its own Goal — so with the boxes always on screen, someone
    // carefully writing a task for a PR Author got a PR authored from a package that
    // never saw it. The copy asserted the effect too.
    await mount();
    expect(task()).toBeTruthy(); // clean-room: both fields
    expect(criteria()).toBeTruthy();

    await click(row('mine-1')); // a `briefed` template
    expect(byTestId('dispatch-task')).toBeNull();
    expect(byTestId('dispatch-criteria')).toBeNull();
    // …and it says WHY, rather than the box just being shorter for no reason.
    expect(byTestId('dispatch-no-fields').textContent).toBe(en.dispatch.noTaskFields);
  });

  it('⚠️ SENDS NEITHER FIELD for a policy that does not read them', async () => {
    // Absent, not empty: `dispatch-context.ts` treats the two differently — absent
    // means "read the transcript", empty means "the user says it is not known" — and
    // sending a stale value from a previously selected clean-room template would make
    // the absent branch one no UI could ever reach.
    await mount();
    await type(task(), 'typed while clean-room was selected');
    await click(row('mine-1'));
    await click(go());
    expect(prepares).toEqual([{ templateId: 'mine-1' }]);
  });

  it('a multi-line task survives the field it is typed into', async () => {
    // Review: the first version used `<input type="text">`, and HTML's value
    // sanitisation strips CR/LF — so a prefilled multi-line opening prompt, which is
    // the common shape, was silently flattened into one run-together sentence before
    // main ever saw it.
    const LF = String.fromCharCode(10);
    const twoLines = `Do the first thing.${LF}Then the second.`;
    await mount({ templates: [reviewer], taskStatement: twoLines });
    expect(task().value).toBe(twoLines);
    await click(go());
    expect(prepares[0].taskStatement).toBe(twoLines);
  });

  it('⚠️ SENDS AN EMPTY LINE AS EMPTY, and warns that it will', async () => {
    // Main honours a cleared line as a choice and prints "not known" rather than
    // putting the transcript's answer back. So the dialog has to say so — otherwise
    // someone clears the box expecting the default.
    await mount();
    await type(task(), '');
    expect(host.textContent).toContain(en.dispatch.taskEmpty);
    await click(go());
    expect(prepares[0].taskStatement).toBe('');
  });

  it('passes acceptance criteria through, and they start empty', async () => {
    // Nothing in a transcript is labelled with these (#947), so there is nothing to
    // prefill them from — which is exactly why the field is here.
    await mount();
    expect(criteria().value).toBe('');
    await type(criteria(), 'Arrow keys move between sessions.');
    await click(go());
    expect(prepares[0].acceptanceCriteria).toBe('Arrow keys move between sessions.');
  });

  it('starts blank when the session has no opening prompt to read', async () => {
    await mount({ templates: [reviewer] });
    expect(task().value).toBe('');
  });
});

describe('dispatching, and refusing to', () => {
  it('hands the prepared dispatch to the caller once', async () => {
    await mount();
    await click(go());
    expect(dispatched).toEqual([
      { ok: true, dispatchId: 'd-1', folder: 'C:/Projects/App', templateName: 'Code Reviewer' },
    ]);
  });

  it('⚠️ CANNOT BE PRESSED TWICE — a second prepare is a second card', async () => {
    await mount();
    await click(go());
    await click(go());
    expect(prepares).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
  });

  it('⚠️ SHOWS A REFUSAL AND STAYS OPEN, using the catalogue key when there is one', async () => {
    answer = {
      ok: false,
      reason: 'that session has no conversation to adopt yet',
      reasonKey: 'dispatch.refusal.noConversation',
    };
    await mount();
    await click(go());
    expect(dispatched).toEqual([]);
    expect(byTestId('dispatch-failed').textContent).toBe(en.dispatch.refusal.noConversation);
    // Still open, and pressable again — the user can pick another role.
    expect(byTestId('dispatch-dialog')).toBeTruthy();
    expect(go().disabled).toBe(false);
  });

  it('falls back to the developer sentence when there is no key', async () => {
    // `DispatchContextResult` draws that line deliberately: a `reasonKey` is present
    // exactly when there is something the user can act on. Showing the raw reason
    // for the rest beats showing nothing.
    answer = { ok: false, reason: 'no such session' };
    await mount();
    await click(go());
    expect(byTestId('dispatch-failed').textContent).toContain('no such session');
  });

  it('shows a rejected bridge call rather than doing nothing at all', async () => {
    await act(async () => {
      root.render(
        <DispatchDialog
          fromName="TradingApp"
          options={OPTIONS}
          onCancel={() => {
            cancelled++;
          }}
          onPrepare={() => Promise.reject(new Error('broker said no'))}
          onDispatch={(p) => dispatched.push(p)}
        />
      );
    });
    await click(go());
    expect(byTestId('dispatch-failed').textContent).toContain('broker said no');
    expect(go().disabled).toBe(false);
  });

  it('says so when there are no templates at all', async () => {
    await mount({ templates: [] });
    expect(host.textContent).toContain(en.dispatch.noTemplates);
    expect(go().disabled).toBe(true);
  });
});

describe('committing nothing', () => {
  it('Cancel dispatches nothing', async () => {
    await mount();
    await click(byTestId('dispatch-cancel'));
    expect(cancelled).toBe(1);
    expect(prepares).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it('Escape dispatches nothing', async () => {
    await mount();
    await act(async () => {
      byTestId('dispatch-dialog').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    expect(cancelled).toBe(1);
    expect(prepares).toEqual([]);
  });

  it('a click on the scrim dispatches nothing, and one INSIDE does not close it', async () => {
    await mount();
    const scrim = byTestId('dispatch-dialog').parentElement!;
    await act(async () => {
      byTestId('dispatch-dialog').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(cancelled).toBe(0);
    await act(async () => {
      scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(cancelled).toBe(1);
    expect(prepares).toEqual([]);
  });

  it('is a modal dialog with an accessible name, and takes focus', async () => {
    await mount();
    const dialog = byTestId('dispatch-dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe(en.dispatch.title);
    expect(document.activeElement).toBe(dialog);
  });

  it('marks the chosen row for a screen reader, not with colour alone (§5.32)', async () => {
    await mount();
    expect(row('builtin:code-reviewer').getAttribute('aria-checked')).toBe('true');
    expect(row('mine-1').getAttribute('aria-checked')).toBe('false');
    await click(row('mine-1'));
    expect(row('mine-1').getAttribute('aria-checked')).toBe('true');
    // …and a real character carries it too, so it survives a screenshot.
    expect(row('mine-1').textContent).toContain(en.dispatch.currentMark);
  });
});
