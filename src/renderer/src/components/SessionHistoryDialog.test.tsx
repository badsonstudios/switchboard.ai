// @vitest-environment jsdom
// The session-history picker (P2-E20-01, §5.33).
//
// This file owns what only a RENDERED picker can answer: that a row's
// description is shown the way its SOURCE deserves (a first prompt is the
// user's own words and is quoted; a title is not), that a conversation another
// card already holds is visible but inert, that an unreadable directory says so
// instead of rendering as an empty folder, and that a refusal — which resolves
// TRUTHY (#440) — never paints as a listing.
//
// The listing rules themselves live in `main/transcripts/history.ts` and are
// tested there; nothing here re-asserts them.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { SessionHistoryDialog, HistoryPick } from './SessionHistoryDialog';
import { initI18nForTests } from '../i18n/test-i18n';
import { ipcRefusal } from '../../../shared/ipc/refusal';
import type { ConversationHistory, ConversationRow } from '../../../shared/session-history';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;
// `unknown`, not `ConversationHistory`: half these cases hand the component
// something that is NOT a listing — a broker refusal — which is the point.
let answer: unknown;
let calls: Array<{ scope: string; folder?: string }>;

function row(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    nativeId: 'conv-1',
    folder: 'C:/work/app',
    description: 'Fix the login redirect',
    descriptionFrom: 'title',
    lastActiveMs: Date.now(),
    claimed: false,
    ...over,
  };
}

function installBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      history: (req: { scope: string; folder?: string }) => {
        calls.push(req);
        return Promise.resolve(answer);
      },
    },
  };
}

async function mount(
  props: Partial<Parameters<typeof SessionHistoryDialog>[0]> = {}
): Promise<{ picked: HistoryPick[]; closed: number; fresh: number }> {
  const picked: HistoryPick[] = [];
  const state = { closed: 0, fresh: 0 };
  await act(async () => {
    root.render(
      <SessionHistoryDialog
        open
        folder="C:/work/app"
        onClose={() => (state.closed += 1)}
        onPick={(p) => picked.push(p)}
        {...props}
      />
    );
  });
  await settle();
  return { picked, get closed() { return state.closed; }, get fresh() { return state.fresh; } };
}

async function settle(): Promise<void> {
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
  await settle();
}

async function type(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('[data-history-search]')!;
  await act(async () => {
    // React keeps a value TRACKER per input and skips the change when the DOM
    // value it reads matches what it last wrote — so assigning `.value` plainly
    // updates the box and fires nothing. Going through the prototype's own
    // setter is what moves the tracker with it. `Reflect.apply` rather than
    // `.call`, so the setter is never referenced as an unbound method.
    // A DOM prototype ACCESSOR, not a class method: there is no instance to
    // bind it to, and `Reflect.apply` supplies the receiver explicitly on the
    // line below, so the rule's hazard (a method losing its `this`) cannot
    // occur. The directive has to be the LAST comment line before the code —
    // continuing the justification underneath it aims it at a comment.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) Reflect.apply(setter, input, [value]);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function press(key: string): Promise<void> {
  const dialog = host.querySelector<HTMLElement>('[data-history-dialog]')!;
  await act(async () => {
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  await settle();
}

const rows = (): HTMLElement[] => Array.from(host.querySelectorAll<HTMLElement>('[data-history-row]'));
const text = (): string => host.textContent ?? '';

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  answer = { status: 'ok', rows: [row()], truncated: false } satisfies ConversationHistory;
  installBridge();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('SessionHistoryDialog', () => {
  it('opens on the FOLDER scope — the CLI picker default, and the reason the common case is short', async () => {
    await mount();
    expect(calls).toEqual([{ scope: 'folder', folder: 'C:/work/app' }]);
    expect(rows()).toHaveLength(1);
  });

  it('shows a title as-is and a first prompt in quotation marks', async () => {
    answer = {
      status: 'ok',
      truncated: false,
      rows: [
        row({ nativeId: 'a', description: 'Fix the login redirect', descriptionFrom: 'title' }),
        row({ nativeId: 'b', description: 'why is the build slow', descriptionFrom: 'prompt' }),
      ],
    } satisfies ConversationHistory;
    await mount();
    // The distinction is the point: one is Claude's summary of the conversation,
    // the other is the user's own opening words.
    expect(text()).toContain('Fix the login redirect');
    expect(text()).toContain('“why is the build slow”');
    expect(text()).not.toContain('“Fix the login redirect”');
  });

  it('says so in words when a conversation has neither a title nor an opening prompt', async () => {
    answer = {
      status: 'ok',
      truncated: false,
      rows: [row({ description: '', descriptionFrom: 'none' })],
    } satisfies ConversationHistory;
    await mount();
    expect(text()).toContain('no title or opening prompt');
  });

  it('a conversation another card holds is SHOWN, disabled, and cannot be picked', async () => {
    // Shown rather than hidden: hiding it sends the user hunting for a
    // conversation that is on screen behind them. Inert rather than openable:
    // plain `--resume` appends, so two cards would write one file.
    answer = {
      status: 'ok',
      truncated: false,
      rows: [row({ claimed: true })],
    } satisfies ConversationHistory;
    const h = await mount();
    const only = rows()[0];
    expect(only.getAttribute('aria-disabled')).toBe('true');
    expect(text()).toContain('already open');
    await click(only);
    expect(h.picked).toEqual([]);
  });

  it('picking one answers with the conversation AND its own folder', async () => {
    // Its own folder, not the picker's: once the list is widened, the row's
    // folder is the one the new card has to open in.
    answer = {
      status: 'ok',
      truncated: false,
      rows: [row({ nativeId: 'conv-9', folder: 'D:/elsewhere/api' })],
    } satisfies ConversationHistory;
    const h = await mount();
    await click(rows()[0]);
    expect(h.picked).toEqual([{ nativeId: 'conv-9', folder: 'D:/elsewhere/api' }]);
  });

  it('an unreadable or over-large directory REPORTS ITSELF rather than looking empty', async () => {
    // §5.33: a list that quietly omits what you wanted is worse than one that
    // admits its limit.
    answer = {
      status: 'unknown',
      reason: '/projects/app: 6259 entries is past the 500 this will scan',
    } satisfies ConversationHistory;
    await mount();
    expect(text()).toContain('past the 500');
    expect(text()).not.toContain('No previous conversations');
    expect(rows()).toHaveLength(0);
  });

  it('a REFUSAL never paints as a listing (#440 — a refusal resolves truthy)', async () => {
    // The brand is truthy, so a component reading the answer without `answered`
    // would render it as an object with no rows and call the folder empty.
    answer = ipcRefusal('transcripts:history', 'capability-not-held');
    await mount();
    expect(text()).toContain("couldn't be opened");
    expect(rows()).toHaveLength(0);
  });

  it('typing filters the answer it already has, and says when nothing matches', async () => {
    answer = {
      status: 'ok',
      truncated: false,
      rows: [
        row({ nativeId: 'a', description: 'Fix the login redirect' }),
        row({ nativeId: 'b', description: 'Rewrite the migration' }),
      ],
    } satisfies ConversationHistory;
    await mount();
    await type('migra');
    expect(rows()).toHaveLength(1);
    expect(text()).toContain('Rewrite the migration');
    // filtering must not re-scan the disk
    expect(calls).toHaveLength(1);
    await type('zzz');
    expect(rows()).toHaveLength(0);
    expect(text()).toContain('Nothing matches');
  });

  it('the scope toggle re-asks for ALL projects, and rows then carry their folder', async () => {
    await mount();
    expect(host.querySelector('[data-history-folder]')).toBeNull();
    answer = {
      status: 'ok',
      truncated: false,
      rows: [row({ folder: 'D:/elsewhere/api' })],
    } satisfies ConversationHistory;
    await click(host.querySelector('[data-history-scope]'));
    expect(calls[1]).toEqual({ scope: 'all', folder: 'C:/work/app' });
    expect(host.querySelector('[data-history-folder]')?.textContent).toBe('D:/elsewhere/api');
  });

  it('a truncated answer says the list has an end — it is not a refusal', async () => {
    answer = { status: 'ok', truncated: true, rows: [row()] } satisfies ConversationHistory;
    await mount();
    expect(host.querySelector('[data-history-truncated]')).not.toBeNull();
  });

  it('an empty folder says so plainly', async () => {
    answer = { status: 'ok', truncated: false, rows: [] } satisfies ConversationHistory;
    await mount();
    expect(text()).toContain('No previous conversations in this folder');
  });

  it('Escape closes, and Enter opens the selected row', async () => {
    const h = await mount();
    await press('Escape');
    expect(h.closed).toBe(1);
    const h2 = await mount();
    await press('Enter');
    expect(h2.picked).toHaveLength(1);
  });

  it('offers "start a new conversation instead" ONLY when that is a real option', async () => {
    // The card-header entry point has no such escape to offer — the user is not
    // mid-gesture there, they are browsing.
    await mount();
    expect(host.querySelector('[data-history-new]')).toBeNull();
    const fresh = vi.fn();
    await mount({ onNewConversation: fresh });
    await click(host.querySelector('[data-history-new]'));
    expect(fresh).toHaveBeenCalledOnce();
  });

  it('carries listbox semantics, which the composer popup still lacks (#828)', async () => {
    await mount();
    const list = host.querySelector('[data-history-rows]')!;
    expect(list.getAttribute('role')).toBe('listbox');
    expect(rows()[0].getAttribute('role')).toBe('option');
    expect(rows()[0].getAttribute('aria-selected')).toBe('true');
    const input = host.querySelector('[data-history-search]')!;
    expect(input.getAttribute('role')).toBe('combobox');
    // the IDREF must resolve to the row, and must not be a stable published name
    const active = input.getAttribute('aria-activedescendant')!;
    expect(active).not.toBe('');
    // An attribute selector rather than `#id`: `useId` produces `:r0:`-shaped
    // ids, which are not valid CSS identifiers, and jsdom has no `CSS.escape`.
    expect(host.querySelector(`[id="${active}"]`)).toBe(rows()[0]);
  });
});
