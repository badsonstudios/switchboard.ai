// @vitest-environment jsdom
// The MCP Manager pane (#632, §5.17) — PR 1, read-only.
//
// The scope MODEL is `main/mcp/config.ts`'s and is tested there on real file
// fixtures; the health PARSER is `main/mcp/health.ts`'s. This file owns what
// only a mounted dialog can answer:
//
//   • the two-call shape — draw from the config, fill the status in after —
//     which is the whole reason `mcp:list` and `mcp:health` are separate
//     channels rather than one;
//   • the precedence between approval and health in the status column;
//   • that a scope we could not READ is said out loud beside the ones we could,
//     instead of looking like "you have none";
//   • and that a slow answer for the session you just LEFT never paints.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import {
  McpManagerDialog,
  failureMessage,
  rowStatus,
  runtimeStatus,
  toolPreview,
} from './McpManagerDialog';
import { initI18nForTests } from '../i18n/test-i18n';
import type {
  McpHealthWire,
  McpInventoryWire,
  McpMutationResult,
  McpReconnectResult,
  McpRuntimeServer,
  McpServerWire,
  McpStatusWire,
} from '../../../shared/mcp';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;

const server = (over: Partial<McpServerWire> & { name: string }): McpServerWire => ({
  scope: 'user',
  transport: 'stdio',
  approval: 'n/a',
  target: 'node',
  args: [],
  envKeys: [],
  headerKeys: [],
  source: 'C:/Users/x/.claude.json',
  ...over,
});

/** what the two channels answer, per test */
let listAnswer: (folder: string) => McpInventoryWire;
let healthAnswer: (folder: string) => McpHealthWire;
/**
 * What `mcp:status` answers (#729) — `null` means the channel is ABSENT.
 *
 * NULL IS THE DEFAULT ON PURPOSE. Every #632/#714 test above was written
 * against a pane that had only the config files, and that path still exists for
 * real (a suspended card, a Terminal session). Leaving the channel off by
 * default keeps those tests testing what they were written to test, and makes
 * every runtime-path test opt in visibly.
 */
let statusAnswer: ((folder: string, liveId: string) => McpStatusWire) | null;
/** how many times the pane asked — the assertion for the settle poll, kept out
 *  of `calls` so it cannot perturb the older order assertions */
let statusCalls: Array<{ folder: string; liveId: string }>;
/** resolves the health call by hand, so "before it lands" is a real state */
let releaseHealth: (() => void) | null = null;

/** every write call the pane made, in order — the assertion for "what did that
 *  button actually run" */
let calls: Array<{ channel: string; args: unknown[] }>;
/** what each write channel answers, per test */
let addAnswer: McpMutationResult;
let removeAnswer: McpMutationResult;
let resetAnswer: McpMutationResult;
let reconnectAnswer: McpReconnectResult;

function installBridge(): void {
  const record =
    <T,>(channel: string, answer: () => T) =>
    (...args: unknown[]): Promise<T> => {
      calls.push({ channel, args });
      return Promise.resolve(answer());
    };
  (window as unknown as { switchboard: unknown }).switchboard = {
    mcp: {
      list: (folder: string) => {
        calls.push({ channel: 'list', args: [folder] });
        return Promise.resolve(listAnswer(folder));
      },
      health: (folder: string) => {
        calls.push({ channel: 'health', args: [folder] });
        return new Promise((resolve) => {
          const fire = (): void => resolve(healthAnswer(folder));
          if (releaseHealth === null) fire();
          else releaseHealth = fire;
        });
      },
      // Registered only when a test asked for it, so the absent-channel case —
      // which is what a broken preload bridge looks like — stays reachable.
      ...(statusAnswer
        ? {
            status: (folder: string, liveId: string) => {
              statusCalls.push({ folder, liveId });
              return Promise.resolve(statusAnswer!(folder, liveId));
            },
          }
        : {}),
      add: record('add', () => addAnswer),
      remove: record('remove', () => removeAnswer),
      resetApprovals: record('resetApprovals', () => resetAnswer),
      reconnect: record('reconnect', () => reconnectAnswer),
    },
  };
}

async function mount(
  folder: string | null = 'C:/p/acme',
  liveId: string | null = 'L1'
): Promise<void> {
  await act(async () => {
    root.render(
      <McpManagerDialog open onClose={() => {}} folder={folder} liveId={liveId} />
    );
  });
  // the list await
  await act(async () => {
    await Promise.resolve();
  });
}

/** click, then let the mutation's promise chain and the re-list settle */
async function click(el: Element | null): Promise<void> {
  expect(el, 'element to click').not.toBeNull();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** the first button whose visible text is exactly this */
const button = (label: string): HTMLButtonElement | null =>
  Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) ?? null;

const setInput = async (selector: string, value: string): Promise<void> => {
  const el = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  expect(el, selector).not.toBeNull();
  await act(async () => {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    // React installs its own value setter on the element; going through the
    // prototype's is what makes `input` carry the new value to onChange.
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const select = async (selector: string, value: string): Promise<void> => {
  const el = host.querySelector<HTMLSelectElement>(selector);
  expect(el, selector).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el!.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const rows = (): HTMLElement[] => Array.from(host.querySelectorAll<HTMLElement>('[data-mcp-server]'));
const rowFor = (name: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-mcp-server="${name}"]`)!;
const text = (): string => host.textContent ?? '';

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
});

beforeEach(() => {
  releaseHealth = null;
  calls = [];
  addAnswer = { ok: true };
  removeAnswer = { ok: true };
  resetAnswer = { ok: true };
  reconnectAnswer = { outcome: 'typed' };
  listAnswer = (folder) => ({ folder, servers: [], unreadable: [] });
  healthAnswer = (folder) => ({ folder, states: {}, ok: true });
  statusAnswer = null;
  statusCalls = [];
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

describe('rowStatus — approval beats health, and that is the decision', () => {
  // An unapproved `.mcp.json` server is one the CLI has DELIBERATELY not
  // connected to. Reporting "not connecting" for it would be true and useless:
  // it describes the symptom and hides the cause, and the user would go looking
  // for a network problem that is not there.
  it('says pending even when the health check has no verdict', () => {
    const s = server({ name: 'x', scope: 'project', approval: 'pending' });
    expect(rowStatus(s, 'unknown').token).toBe('pending');
    expect(rowStatus(s, 'failed').token).toBe('pending');
    expect(rowStatus(s, 'connected').token).toBe('pending');
  });

  it('says disabled over any health answer too', () => {
    const s = server({ name: 'x', scope: 'project', approval: 'disabled' });
    expect(rowStatus(s, 'connected').token).toBe('disabled');
  });

  it('lets health speak once approval has nothing to say', () => {
    const s = server({ name: 'x', approval: 'n/a' });
    expect(rowStatus(s, 'connected').token).toBe('connected');
    expect(rowStatus(s, 'failed').token).toBe('failed');
    expect(rowStatus(s, 'unknown').token).toBe('unknown');
  });
});

describe('the two-call shape', () => {
  it('draws the servers BEFORE the health check has answered', async () => {
    // THE POINT OF SPLITTING THE CHANNELS. A health check connects to every
    // configured server and can take seconds behind a dead VPN; a manager that
    // waited for it would hang on exactly the condition it exists to diagnose.
    releaseHealth = () => {};
    listAnswer = (folder) => ({
      folder,
      servers: [server({ name: 'sentry', transport: 'http', target: 'https://mcp.sentry.dev' })],
      unreadable: [],
    });
    healthAnswer = (folder) => ({ folder, states: { sentry: 'connected' }, ok: true });

    await mount();

    // painted, with an honest "we do not know yet" rather than a guess
    expect(rows()).toHaveLength(1);
    expect(rowFor('sentry').dataset.mcpState).toBe('unknown');

    await act(async () => {
      releaseHealth?.();
      await Promise.resolve();
    });
    expect(rowFor('sentry').dataset.mcpState).toBe('connected');
  });

  it('drops an answer for a folder the user has already left', async () => {
    // Both channels echo the folder they were asked about precisely so a slow
    // answer cannot paint onto the session you switched to. Without the echo
    // check this test paints another session's servers.
    listAnswer = () => ({
      folder: 'C:/p/SOMEWHERE-ELSE',
      servers: [server({ name: 'ghost' })],
      unreadable: [],
    });
    await mount('C:/p/acme');
    expect(rows()).toHaveLength(0);
    // ...AND IS NOT STILL CLAIMING TO BE LOADING. Review caught that the
    // assertion above passed while the pane sat on "Reading your
    // configuration…" for ever: `setLoading(false)` was after the guards, so
    // every early return stranded it with no way out but close-and-reopen.
    expect(text()).not.toContain('Reading your configuration');
  });

  it('does not strand the pane when the bridge is missing entirely', () => {
    // `App.tsx`'s shim exists because a broken preload must degrade rather than
    // blank the window; an unguarded `window.switchboard.mcp.list` here would
    // be a TypeError inside the effect's IIFE — an unhandled rejection AND a
    // permanent loading state.
    return (async () => {
      delete (window as unknown as { switchboard?: unknown }).switchboard;
      await mount();
      expect(text()).not.toContain('Reading your configuration');
      expect(rows()).toHaveLength(0);
    })();
  });
});

describe('what it says when there is nothing to say', () => {
  it('asks for a session rather than claiming there are no servers', async () => {
    await mount(null);
    expect(text()).toContain('Open a session');
    expect(rows()).toHaveLength(0);
  });

  it('says the session has none, which is a different sentence', async () => {
    await mount();
    expect(text()).toContain('No MCP servers are configured');
  });
});

describe('a file that could not be read (P6)', () => {
  it('is reported BESIDE the servers that read fine', async () => {
    // A `.mcp.json` with a trailing comma in it must not blank the user-scope
    // servers that are perfectly readable — and a silently empty section would
    // read as "you have none" rather than "we could not look".
    listAnswer = (folder) => ({
      folder,
      servers: [server({ name: 'mine', scope: 'user' })],
      unreadable: [{ source: 'C:/p/acme/.mcp.json', scopes: ['project'] }],
    });
    await mount();
    expect(rows().map((r) => r.dataset.mcpServer)).toEqual(['mine']);
    expect(text()).toContain('Could not read');
    expect(text()).toContain('C:/p/acme/.mcp.json');
  });

  it('says it ONCE for a file that backs two scopes, and names both (#714)', async () => {
    // `~/.claude.json` is the local scope AND the user scope, so the old
    // per-scope rendering put two identical complaints on screen for one broken
    // file — which reads as two problems and sends you hunting for the second.
    listAnswer = (folder) => ({
      folder,
      servers: [],
      unreadable: [{ source: 'C:/Users/x/.claude.json', scopes: ['local', 'user'] }],
    });
    await mount();
    expect(host.querySelectorAll('[data-mcp-unreadable]')).toHaveLength(1);
    // ...and both scopes are still named, so nothing is hidden by saying it once
    expect(text()).toContain('This project (just you)');
    expect(text()).toContain('All your projects');
  });

  it('does not claim the session has no servers when a file simply would not parse', async () => {
    listAnswer = (folder) => ({
      folder,
      servers: [],
      unreadable: [{ source: 'C:/p/acme/.mcp.json', scopes: ['project'] }],
    });
    await mount();
    expect(text()).not.toContain('No MCP servers are configured');
  });
});

describe('secrets', () => {
  it('names the keys a server carries and shows no value — there is none to show', async () => {
    // The wire shape has no field that can hold a value (`shared/mcp.ts`), so
    // this is belt-and-braces at the last surface before a screen-share.
    listAnswer = (folder) => ({
      folder,
      servers: [
        server({
          name: 'sentry',
          transport: 'http',
          target: 'https://mcp.sentry.dev',
          envKeys: ['API_KEY'],
          headerKeys: ['Authorization'],
        }),
      ],
      unreadable: [],
    });
    await mount();
    expect(text()).toContain('API_KEY');
    expect(text()).toContain('Authorization');
    expect(text()).toContain('https://mcp.sentry.dev');
  });
});

// ── The write half (#714) ───────────────────────────────────────────────────

describe('failureMessage', () => {
  // the key itself, plus `at` when there is one — so the assertions below are
  // about WHICH string was chosen, not about how English words it
  const t = (key: string, vars?: Record<string, unknown>): string => {
    const at = typeof vars?.at === 'string' ? vars.at : '';
    return at ? `${key}:${at}` : key;
  };

  it('passes the CLI’s own words through untouched', () => {
    // "MCP server sentry already exists in .mcp.json" names the exact file and
    // is a better sentence than anything we would write.
    expect(
      failureMessage({ ok: false, reason: 'cli-failed', detail: 'already exists in .mcp.json' }, t)
    ).toBe('already exists in .mcp.json');
  });

  it('has a sentence of its own for the failures the CLI never got to explain', () => {
    expect(failureMessage({ ok: false, reason: 'no-cli' }, t)).toBe('mcp.error.noCli');
    expect(failureMessage({ ok: false, reason: 'timeout' }, t)).toBe('mcp.error.timeout');
    expect(failureMessage({ ok: false, reason: 'refused' }, t)).toBe('mcp.error.refused');
  });

  it('points a validation failure at its own field’s wording', () => {
    expect(
      failureMessage(
        { ok: false, reason: 'invalid', error: { field: 'env', code: 'format', at: 'A B' } },
        t
      )
    ).toBe('mcp.form.error.format:A B');
  });
});

describe('adding a server', () => {
  const openForm = async (): Promise<void> => {
    await mount();
    await click(button('Add server…'));
  };

  it('builds the request from the form and re-lists afterwards', async () => {
    await openForm();
    await setInput('[data-mcp-field="name"]', 'sentry');
    await setInput('[data-mcp-field="target"]', 'npx');
    // ONE ARGUMENT PER LINE, so `--dir "C:\\Program Files\\x"` needs no quoting
    // rules and no shell parser (`parseArgLines`).
    await setInput('[data-mcp-field="args"]', '-y\n@some/mcp-server');
    await click(button('Add server'));

    expect(calls.filter((c) => c.channel === 'add')).toHaveLength(1);
    const added = calls.filter((c) => c.channel === 'add')[0];
    expect(added.args[0]).toBe('C:/p/acme');
    expect(added.args[1]).toEqual({
      name: 'sentry',
      scope: 'local',
      transport: 'stdio',
      target: 'npx',
      args: ['-y', '@some/mcp-server'],
      env: [],
    });
    // the form closed, and the pane re-read the config rather than guessing
    expect(host.querySelector('[data-testid="mcp-add-form"]')).toBeNull();
    expect(text()).toContain('Added sentry');
  });

  it('REFUSES BEFORE THE ROUND TRIP what main would refuse anyway', async () => {
    // Same `validateAdd` on both sides (`shared/mcp-args.ts`). A form that
    // accepted what main rejects reads on screen as a button that does nothing.
    await openForm();
    await setInput('[data-mcp-field="name"]', '--help');
    await setInput('[data-mcp-field="target"]', 'npx');
    await click(button('Add server'));
    expect(calls.filter((c) => c.channel === 'add')).toHaveLength(0);
    expect(host.querySelector('[data-mcp-form-error="name"]')).not.toBeNull();
  });

  it('does not scold you for a name you have not finished typing', async () => {
    await openForm();
    await setInput('[data-mcp-field="name"]', 'se');
    expect(host.querySelector('[data-mcp-form-error]')).toBeNull();
  });

  it('sends headers for a remote server and env for a local one, never both', async () => {
    await openForm();
    await setInput('[data-mcp-field="name"]', 'sentry');
    await select('[data-mcp-field="transport"]', 'http');
    await setInput('[data-mcp-field="target"]', 'https://mcp.sentry.dev/mcp');
    await click(button('Add a header'));
    await setInput('[data-mcp-pair-key="0"]', 'Authorization');
    await setInput('[data-mcp-pair-value="0"]', 'Bearer tok');
    await click(button('Add server'));

    expect(calls.filter((c) => c.channel === 'add')[0].args[1]).toEqual({
      name: 'sentry',
      scope: 'local',
      transport: 'http',
      target: 'https://mcp.sentry.dev/mcp',
      headers: [{ key: 'Authorization', value: 'Bearer tok' }],
    });
  });

  it('clears the pairs when the kind changes, so headers cannot ship as env vars', async () => {
    await openForm();
    await click(button('Add a variable'));
    await setInput('[data-mcp-pair-key="0"]', 'API_KEY');
    await select('[data-mcp-field="transport"]', 'http');
    expect(host.querySelector('[data-mcp-pair-key="0"]')).toBeNull();
  });

  it('types a credential into a PASSWORD field — the screen-share case', async () => {
    await openForm();
    await click(button('Add a variable'));
    expect(
      host.querySelector<HTMLInputElement>('[data-mcp-pair-value="0"]')?.type
    ).toBe('password');
  });

  it('tells the user where a key belongs, at the moment they are deciding', async () => {
    // #632 left `args` unredacted as a stated limit, because guessing which of
    // an arbitrary program's flags are secrets is wrong in both directions. The
    // fix is not detection — it is giving the key a home and saying so here.
    await openForm();
    expect(text()).toContain('Do not put an API key here');
  });

  it('shows the CLI’s own refusal and keeps the form open to fix it', async () => {
    addAnswer = {
      ok: false,
      reason: 'cli-failed',
      detail: 'MCP server sentry already exists in .mcp.json',
    };
    await openForm();
    await setInput('[data-mcp-field="name"]', 'sentry');
    await setInput('[data-mcp-field="target"]', 'npx');
    await click(button('Add server'));
    expect(text()).toContain('already exists in .mcp.json');
    expect(host.querySelector('[data-testid="mcp-add-form"]')).not.toBeNull();
  });
});

describe('removing a server', () => {
  const withServer = async (over: Partial<McpServerWire> = {}): Promise<void> => {
    listAnswer = (folder) => ({
      folder,
      servers: [server({ name: 'sentry', scope: 'local', ...over })],
      unreadable: [],
    });
    await mount();
  };

  it('asks first, then passes the ROW’S OWN SCOPE', async () => {
    // The CLI's scopeless remove deletes from "whichever scope has it", and
    // this pane deliberately lists one name twice when two scopes define it —
    // so "whichever" would be the wrong row about half the time.
    await withServer({ scope: 'project' });
    await click(button('Remove'));
    expect(calls.filter((c) => c.channel === 'remove')).toHaveLength(0);
    await click(button('Remove it'));
    expect(calls.filter((c) => c.channel === 'remove')[0].args).toEqual([
      'C:/p/acme',
      'sentry',
      'project',
    ]);
    expect(text()).toContain('Removed sentry');
  });

  it('can be backed out of', async () => {
    await withServer();
    await click(button('Remove'));
    await click(button('Cancel'));
    expect(calls.filter((c) => c.channel === 'remove')).toHaveLength(0);
    expect(button('Remove')).not.toBeNull();
  });

  it('re-lists even when the removal FAILED, so the list and the error agree', async () => {
    removeAnswer = { ok: false, reason: 'cli-failed', detail: 'No MCP server named "sentry"' };
    await withServer();
    const before = calls.filter((c) => c.channel === 'list').length;
    await click(button('Remove'));
    await click(button('Remove it'));
    expect(text()).toContain('No MCP server named');
    // the config is re-read: a stale list beside "there is no such server" is
    // the pane telling the user two contradictory things
    expect(calls.filter((c) => c.channel === 'list').length).toBeGreaterThan(before);
  });
});

describe('reconnect — the pane does not decide what it means', () => {
  it('reports that /mcp was typed into a terminal session', async () => {
    await mount();
    await click(button('Reconnect'));
    expect(calls.filter((c) => c.channel === 'reconnect')[0].args).toEqual(['C:/p/acme', 'L1']);
    expect(text()).toContain('Typed /mcp into the session');
  });

  it('SAYS RESTART for a Direct session rather than pretending it worked', async () => {
    // Main sends nothing at all on the stream transport — `/mcp` there opens a
    // picker with no terminal to draw it in, which is the dead end this dialog
    // exists to remove. The renderer's job is to report that honestly.
    reconnectAnswer = { outcome: 'restart-required' };
    await mount();
    await click(button('Reconnect'));
    expect(text()).toContain('restart it to pick up changes');
  });

  it('says so when the card has no live session', async () => {
    reconnectAnswer = { outcome: 'no-session' };
    await mount();
    await click(button('Reconnect'));
    expect(text()).toContain('not running');
  });

  it('does not call main at all when there is no live id to send', async () => {
    await mount('C:/p/acme', null);
    await click(button('Reconnect'));
    expect(calls.filter((c) => c.channel === 'reconnect')).toHaveLength(0);
    expect(text()).toContain('not running');
  });

  it('points a pending project server at it, since there is no approve verb', async () => {
    listAnswer = (folder) => ({
      folder,
      servers: [server({ name: 'shared', scope: 'project', approval: 'pending' })],
      unreadable: [],
    });
    await mount();
    expect(text()).toContain('use Reconnect below');
  });
});

describe('resetting project approvals', () => {
  const withProject = async (approval: McpServerWire['approval'] = 'pending'): Promise<void> => {
    listAnswer = (folder) => ({
      folder,
      servers: [server({ name: 'shared', scope: 'project', approval })],
      unreadable: [],
    });
    await mount();
  };

  it('is not offered when nothing is project-scoped — nothing to reset', async () => {
    // a reset button with nothing to reset invites a pointless question about
    // a blunt, project-wide verb
    await mount();
    expect(button('Reset approvals')).toBeNull();
  });

  it('is offered when there is a project-scope server', async () => {
    await withProject();
    expect(button('Reset approvals')).not.toBeNull();
  });

  it('warns what it does before doing it — it is project-wide and blunt', async () => {
    await withProject();
    await click(button('Reset approvals'));
    expect(text()).toContain('ask about every shared server again');
    expect(calls.filter((c) => c.channel === 'resetApprovals')).toHaveLength(0);
    await click(button('Reset them'));
    expect(calls.filter((c) => c.channel === 'resetApprovals')[0].args).toEqual(['C:/p/acme']);
    expect(text()).toContain('Approvals reset');
  });
});

describe('what this list is NOT (#723)', () => {
  // The report that opened #723 was a screenshot of this pane showing 3 servers
  // beside the CLI's own picker showing 16. Nothing was broken: connectors and
  // plugin servers live in no config file, so the file read cannot reach them.
  // The bug was that a short list read as a complete one. These pin the saying.
  it('says the list is only the config files, with servers on screen', async () => {
    listAnswer = (folder) => ({
      folder,
      servers: [server({ name: 'a' })],
      unreadable: [],
    });
    await mount();
    expect(rows()).toHaveLength(1); // the list it qualifies really rendered
    expect(host.querySelectorAll('[data-mcp-configured-only]')).toHaveLength(1);
    expect(text()).toContain('/mcp');
  });

  it('says it in the EMPTY case too — the one where silence misleads most', async () => {
    // "No MCP servers are configured" beside a CLI picker listing eleven
    // account connectors is the exact reading that produced the bug report, so
    // the qualifier has to survive the branch that has no rows to qualify.
    await mount();
    expect(rows()).toHaveLength(0);
    // the pairing is the point: the empty line AND the qualifier, together
    expect(text()).toContain('No MCP servers are configured');
    expect(host.querySelector('[data-mcp-configured-only]')).not.toBeNull();
  });

  it('stays quiet when there is no session — nothing is being claimed yet', async () => {
    await mount(null);
    expect(host.querySelector('[data-mcp-configured-only]')).toBeNull();
  });
});

describe('when the health check never ran (#714)', () => {
  it('says so ONCE instead of stamping every row "status unknown"', async () => {
    // An absent name used to mean two different things at once: "the CLI has
    // never heard of that server" and "the CLI never answered". `ok` splits them.
    healthAnswer = (folder) => ({ folder, states: {}, ok: false });
    listAnswer = (folder) => ({
      folder,
      servers: [server({ name: 'a' }), server({ name: 'b' })],
      unreadable: [],
    });
    await mount();
    expect(host.querySelectorAll('[data-mcp-health-unavailable]')).toHaveLength(1);
  });

  it('stays quiet when there are no rows it would have had an opinion about', async () => {
    healthAnswer = (folder) => ({ folder, states: {}, ok: false });
    await mount();
    expect(host.querySelector('[data-mcp-health-unavailable]')).toBeNull();
  });

  it('says so when the health channel is REFUSED, not just when ok is false', async () => {
    // A refusal yields `undefined` through `answered`, so the effect returns
    // early. If `healthRan` is not cleared, every row reads "status unknown"
    // and nothing explains why — the exact ambiguity `ok` was added to remove,
    // reintroduced through a different door.
    (
      window as unknown as { switchboard: { mcp: Record<string, unknown> } }
    ).switchboard.mcp.health = () => Promise.resolve(undefined);
    listAnswer = (folder) => ({ folder, servers: [server({ name: 'a' })], unreadable: [] });
    await mount();
    expect(host.querySelector('[data-mcp-health-unavailable]')).not.toBeNull();
  });

  it('does not re-run the expensive check after every mutation', async () => {
    // The listing is two file reads; the health check spawns the CLI and
    // connects to every server, with a 20s ceiling. Three removals must not be
    // three of those.
    listAnswer = (folder) => ({ folder, servers: [server({ name: 'a' })], unreadable: [] });
    await mount();
    const healthCalls = calls.filter((c) => c.channel === 'health').length;
    await click(button('Remove'));
    await click(button('Remove it'));
    expect(calls.filter((c) => c.channel === 'list').length).toBeGreaterThan(1);
    expect(calls.filter((c) => c.channel === 'health')).toHaveLength(healthCalls);
  });
});

describe('a mutation that outlives its sitting says nothing', () => {
  // `runMcp`'s timeout is ten seconds and the dialog is closable throughout, so
  // a Remove started on one session can resolve after the user has closed it
  // and reopened it on ANOTHER. Without an epoch guard its `setNotice` paints
  // "Removed sentry." over a project that has no sentry. Reproduced in review.
  const openOn = async (folder: string): Promise<void> => {
    await act(async () => {
      root.render(<McpManagerDialog open onClose={() => {}} folder={folder} liveId="L1" />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  it('does not paint a notice for the folder the user has left', async () => {
    let settle: (() => void) | null = null;
    (window as unknown as { switchboard: { mcp: Record<string, unknown> } }).switchboard.mcp.remove =
      () =>
        new Promise((resolve) => {
          settle = () => resolve({ ok: true });
        });
    listAnswer = (folder) => ({ folder, servers: [server({ name: 'sentry' })], unreadable: [] });

    await openOn('C:/proj-A');
    // start the removal, but do NOT let it settle
    await click(button('Remove'));
    await click(button('Remove it'));

    // the user closes and reopens on a different session
    await act(async () => {
      root.render(<McpManagerDialog open={false} onClose={() => {}} folder="C:/proj-A" />);
    });
    await openOn('C:/proj-B');

    // ...and only now does the first call come back
    await act(async () => {
      settle?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(text()).not.toContain('Removed sentry');
    expect(host.querySelector('[data-mcp-notice]')).toBeNull();
  });
});

describe('a refused or missing write channel is not silence', () => {
  it('says something rather than leaving an unchanged list looking like success', async () => {
    // `answered` degrades a refused channel to `undefined`, which without the
    // explicit check reads exactly like `{ ok: true }` and leaves the user
    // staring at a list that did not change.
    (window as unknown as { switchboard: { mcp: Record<string, unknown> } }).switchboard.mcp.remove =
      () => Promise.resolve(undefined);
    listAnswer = (folder) => ({ folder, servers: [server({ name: 'sentry' })], unreadable: [] });
    await mount();
    await click(button('Remove'));
    await click(button('Remove it'));
    expect(text()).toContain('could not run that');
  });
});

describe('two scopes defining one name', () => {
  it('draws BOTH rows — the collision is what the pane is for', async () => {
    // `config.ts` deliberately does not deduplicate across scopes. A name-only
    // React key would collapse the two real rows into one and hide exactly the
    // situation the user opened the manager to understand.
    listAnswer = (folder) => ({
      folder,
      servers: [
        server({ name: 'github', scope: 'project', approval: 'approved' }),
        server({ name: 'github', scope: 'user' }),
      ],
      unreadable: [],
    });
    await mount();
    expect(rows()).toHaveLength(2);
    expect(rows().map((r) => r.dataset.mcpScope)).toEqual(['project', 'user']);
  });
});

// ── The runtime inventory (#729) ─────────────────────────────────────────────
//
// Everything above this line is the CONFIG path, and it still exists: a
// suspended card and a Terminal-transport session have no control channel and
// get exactly the behaviour those tests describe. What follows is the path a
// LIVE Direct session takes, which is nearly every session.

/** turn the `mcp:status` channel on for one test, and re-install the bridge */
const useStatus = (answer: (folder: string, liveId: string) => McpStatusWire): void => {
  statusAnswer = answer;
  installBridge();
};

const runtimeServer = (over: Partial<McpRuntimeServer> & { name: string }): McpRuntimeServer => ({
  scope: 'local',
  status: 'connected',
  target: 'npx',
  tools: [],
  readOnly: true,
  envKeys: [],
  headerKeys: [],
  ...over,
});

const ok =
  (servers: McpRuntimeServer[], notLoaded: McpServerWire[] = []) =>
  (_f: string, liveId: string): McpStatusWire => ({
    sessionId: liveId,
    servers,
    notLoaded,
    reason: 'ok',
  });

describe('the runtime list replaces the config list when the session answers', () => {
  it('draws what the SESSION has, not what the files hold', async () => {
    // The #723 gap, closed: the config read finds one server, the session has
    // three — the other two being a connector and a plugin's, which live in no
    // file and could not previously be shown at all.
    listAnswer = (folder) => ({ folder, servers: [server({ name: 'sentry' })], unreadable: [] });
    useStatus(
      ok([
        runtimeServer({ name: 'sentry', scope: 'local' }),
        runtimeServer({ name: 'Slack', scope: 'dynamic' }),
        runtimeServer({ name: 'Linear', scope: 'dynamic' }),
      ])
    );
    await mount();
    expect(rows().map((r) => r.dataset.mcpServer)).toEqual(['sentry', 'Slack', 'Linear']);
  });

  it('does NOT draw both lists — the runtime one is a superset', async () => {
    // Rendering the config rows beside the runtime rows would show `sentry`
    // twice and make the duplicate look like the two-scopes collision.
    listAnswer = (folder) => ({ folder, servers: [server({ name: 'sentry' })], unreadable: [] });
    useStatus(ok([runtimeServer({ name: 'sentry' })]));
    await mount();
    expect(rows()).toHaveLength(1);
  });

  it('does not spawn the health CLI at all when the session answered', async () => {
    // THE SAVING. `mcp:health` connects to every configured server and is
    // allowed twenty seconds; the control channel answered the same question in
    // milliseconds, with a status per server that did not have to be scraped
    // out of prose and matched on glyphs.
    useStatus(ok([runtimeServer({ name: 'sentry' })]));
    await mount();
    expect(calls.map((c) => c.channel)).not.toContain('health');
  });

  it('retires the configured-only footer once the list is no longer a subset', async () => {
    useStatus(ok([runtimeServer({ name: 'sentry' })]));
    await mount();
    expect(host.querySelectorAll('[data-mcp-configured-only]')).toHaveLength(0);
  });

  it('shows the tool names — the fact no config file holds', async () => {
    useStatus(
      ok([runtimeServer({ name: 'DeepWiki', tools: ['ask_question', 'read_wiki_structure'] })])
    );
    await mount();
    expect(text()).toContain('ask_question');
  });
});

describe('a row we cannot mutate says so, rather than offering a button that fails', () => {
  it('renders a read-only marker and NO Remove button for a connector', async () => {
    // #729's own acceptance criterion. You cannot `claude mcp remove` a
    // claude.ai connector — it is in no file, so there is nothing for the
    // subcommand to edit — and a greyed-out button would say "not right now"
    // where the truth is "not ever".
    useStatus(ok([runtimeServer({ name: 'Slack', scope: 'dynamic', readOnly: true })]));
    await mount();
    expect(rowFor('Slack').dataset.mcpReadonly).toBe('');
    expect(rowFor('Slack').querySelector('button')).toBeNull();
    expect(text()).toContain('read-only');
  });

  it('offers Remove for a row a config file vouches for', async () => {
    useStatus(ok([runtimeServer({ name: 'sentry', readOnly: false, removeScope: 'local' })]));
    await mount();
    expect(button('Remove')).not.toBeNull();
  });

  it('removes with the CONFIG scope, never the runtime one', async () => {
    // `claude mcp remove -s dynamic` is not a call that means anything. Main
    // carries the write-side scope across so the renderer never has to narrow
    // one vocabulary into the other.
    useStatus(
      ok([runtimeServer({ name: 'sentry', scope: 'dynamic', readOnly: false, removeScope: 'user' })])
    );
    await mount();
    await click(button('Remove'));
    await click(button('Remove it'));
    expect(calls.find((c) => c.channel === 'remove')?.args).toEqual(['C:/p/acme', 'sentry', 'user']);
  });
});

describe('the measured settle — pending is an answer, not a spinner (#729)', () => {
  it('draws a pending server rather than hiding it', async () => {
    // Measured: every server on a freshly spawned session reports `pending`
    // with no tools for ~5 seconds. Hiding those rows would blink the whole
    // list out of existence on every fresh card.
    useStatus(ok([runtimeServer({ name: 'DeepWiki', status: 'pending' })]));
    await mount();
    expect(rows()).toHaveLength(1);
    expect(rowFor('DeepWiki').dataset.mcpState).toBe('pending');
    expect(text()).toContain('connecting');
  });

  it('asks AGAIN while a row is pending, and stops once it connects', async () => {
    vi.useFakeTimers();
    try {
      let answer = ok([runtimeServer({ name: 'DeepWiki', status: 'pending' })]);
      useStatus((f, id) => answer(f, id));
      await mount();
      expect(statusCalls).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(statusCalls).toHaveLength(2);

      // it settles — and the poll must STOP, not keep asking for ever
      answer = ok([runtimeServer({ name: 'DeepWiki', status: 'connected' })]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(statusCalls).toHaveLength(3);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(statusCalls).toHaveLength(3);
      expect(rowFor('DeepWiki').dataset.mcpState).toBe('connected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a server that never settles, instead of polling for ever', async () => {
    vi.useFakeTimers();
    try {
      useStatus(ok([runtimeServer({ name: 'stuck', status: 'pending' })]));
      await mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      // bounded by STATUS_POLL_LIMIT — the first ask plus seven retries
      expect(statusCalls).toHaveLength(8);
      // ...and the row still says `pending`, which by now is the truth rather
      // than a stale first look
      expect(rowFor('stuck').dataset.mcpState).toBe('pending');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll a list with nothing pending', async () => {
    vi.useFakeTimers();
    try {
      useStatus(ok([runtimeServer({ name: 'DeepWiki', status: 'connected' })]));
      await mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(statusCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('when the session cannot answer, the pane says WHICH reason', () => {
  it.each([
    ['not-stream', 'Terminal mode'],
    ['unavailable', 'answer'],
    ['no-session', 'Start this session'],
  ])('falls back to the config list and explains `%s`', async (reason, phrase) => {
    // #723 exists because "no servers configured" was rendered for a case that
    // meant "we cannot see them". An empty list with no reason would bring that
    // back one layer in.
    listAnswer = (folder) => ({ folder, servers: [server({ name: 'sentry' })], unreadable: [] });
    useStatus((_f, liveId) => ({
      sessionId: liveId,
      servers: [],
      notLoaded: [],
      reason: reason as McpStatusWire['reason'],
    }));
    await mount();
    expect(rows()).toHaveLength(1); // the config list, as before
    const footer = host.querySelector<HTMLElement>('[data-mcp-configured-only]');
    expect(footer).not.toBeNull();
    expect(footer!.dataset.mcpStatusReason).toBe(reason);
    expect(text()).toContain(phrase);
  });

  it('says `no-session` for a suspended card without asking at all', async () => {
    useStatus(ok([runtimeServer({ name: 'never' })]));
    await mount('C:/p/acme', null);
    expect(statusCalls).toHaveLength(0);
    expect(
      host.querySelector<HTMLElement>('[data-mcp-configured-only]')!.dataset.mcpStatusReason
    ).toBe('no-session');
  });

  it('treats a MISSING channel as unavailable, not as an empty session', async () => {
    // The broken-preload case. Without this the pane would draw "no servers"
    // for a session that has sixteen.
    listAnswer = (folder) => ({ folder, servers: [server({ name: 'sentry' })], unreadable: [] });
    await mount(); // statusAnswer stays null — no `status` on the bridge
    expect(rows()).toHaveLength(1);
    expect(
      host.querySelector<HTMLElement>('[data-mcp-configured-only]')!.dataset.mcpStatusReason
    ).toBe('unavailable');
  });

  it('discards an answer for the session the user has already left', async () => {
    // The session echo, same rule as the list effect's folder echo: a slow
    // answer for another card must not paint this one.
    useStatus(() => ({
      sessionId: 'SOMEONE-ELSE',
      servers: [runtimeServer({ name: 'ghost' })],
      notLoaded: [],
      reason: 'ok',
    }));
    await mount();
    expect(rows().map((r) => r.dataset.mcpServer)).not.toContain('ghost');
  });
});

describe('servers the session has NOT loaded (#729, found in review)', () => {
  // MEASURED (`spike/probes/721/probe-mcp-add-live.mjs`): `mcp_status` is
  // frozen at session start. A runtime-only pane therefore answered Add with a
  // list that did not change, and Remove by leaving the row on screen — a
  // regression against #714 that these four tests exist to prevent recurring.
  it('draws them under their own heading, with a working Remove', async () => {
    useStatus(ok([runtimeServer({ name: 'loaded' })], [server({ name: 'justAdded', scope: 'local' })]));
    await mount();
    expect(rows().map((r) => r.dataset.mcpServer)).toEqual(['loaded', 'justAdded']);
    expect(host.querySelector('[data-mcp-section="not-loaded"]')).not.toBeNull();
    expect(rowFor('justAdded').querySelector('button')).not.toBeNull();
  });

  it('says WHY they are listed separately, rather than looking like a duplicate', async () => {
    useStatus(ok([], [server({ name: 'justAdded' })]));
    await mount();
    expect(text()).toContain('Reconnect');
  });

  it('removes one with its own config scope', async () => {
    useStatus(ok([], [server({ name: 'justAdded', scope: 'project' })]));
    await mount();
    await click(button('Remove'));
    await click(button('Remove it'));
    expect(calls.find((c) => c.channel === 'remove')?.args).toEqual([
      'C:/p/acme',
      'justAdded',
      'project',
    ]);
  });

  it('is not "nothing to show" when the session loaded nothing but a file declares one', async () => {
    useStatus(ok([], [server({ name: 'justAdded' })]));
    await mount();
    expect(text()).not.toContain('no MCP servers');
    expect(rows()).toHaveLength(1);
  });
});

describe('the health CLI must not be spawned on a folder whose session answers', () => {
  it('does not spawn it on a folder SWITCH from a suspended card to a live one', async () => {
    // THE STALE-CLOSURE RACE, found in review. Both effects run in one passive
    // flush, so a bare `statusReason` still held the previous render's value
    // ('no-session' from the suspended card) and spawned a 20-second CLI on the
    // new folder — whose session was about to answer anyway. Pairing the reason
    // with its folder+session key makes the stale read unrepresentable.
    useStatus(ok([runtimeServer({ name: 'DeepWiki' })]));
    await act(async () => {
      root.render(<McpManagerDialog open onClose={() => {}} folder="C:/p/a" liveId={null} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    calls.length = 0;
    await act(async () => {
      root.render(<McpManagerDialog open onClose={() => {}} folder="C:/p/b" liveId="L2" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls.map((c) => c.channel)).not.toContain('health');
  });
});

describe('a transient poll failure does not throw away a good list', () => {
  it('keeps the servers already on screen when one tick fails', async () => {
    vi.useFakeTimers();
    try {
      let fail = false;
      statusAnswer = (_f, liveId) =>
        fail
          ? { sessionId: liveId, servers: [], notLoaded: [], reason: 'unavailable' }
          : { sessionId: liveId, servers: [runtimeServer({ name: 'DeepWiki', status: 'pending' })], notLoaded: [], reason: 'ok' };
      installBridge();
      await mount();
      expect(rows()).toHaveLength(1);

      // the channel blips — ten seconds is the control timeout, so this is one
      // slow answer, not a session that has gone
      fail = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      // THE ROW SURVIVES. Clearing it would swap sixteen rows the user is
      // reading for the three-row config subset and put the #723 footer back,
      // all for a blip that said nothing about the servers.
      expect(rows().map((r) => r.dataset.mcpServer)).toEqual(['DeepWiki']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a bridge that THROWS rather than resolving', async () => {
    // `mutate` guards its await and this did not, so a throwing bridge left the
    // status at null for ever — which since the restructure also permanently
    // blocks the health fallback.
    statusAnswer = () => {
      throw new Error('preload exploded');
    };
    installBridge();
    listAnswer = (folder) => ({ folder, servers: [server({ name: 'sentry' })], unreadable: [] });
    await mount();
    expect(
      host.querySelector<HTMLElement>('[data-mcp-configured-only]')!.dataset.mcpStatusReason
    ).toBe('unavailable');
  });
});

describe('approval still beats connection state on the runtime path', () => {
  it('says "waiting for your approval" rather than reporting the symptom', async () => {
    // The precedence `rowStatus` documents at length, which the first runtime
    // renderer silently dropped: an unapproved `.mcp.json` server is one the CLI
    // deliberately has not connected to, so "not connecting" describes the
    // symptom instead of the cause.
    useStatus(ok([runtimeServer({ name: 'shared', scope: 'project', status: 'failed', approval: 'pending' })]));
    await mount();
    expect(rowFor('shared').dataset.mcpState).toBe('pending');
    expect(text()).toContain('waiting for your approval');
  });
});

describe('toolPreview — a 40-tool server must not become a paragraph', () => {
  it('spells out a short list in full', () => {
    expect(toolPreview(['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('bounds a long one with a count for the rest', () => {
    // The GitHub MCP server exposes 40+ tools, on exactly the sixteen-server
    // machine this item exists for.
    expect(toolPreview(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a, b, c, d, e +2');
  });

  it('does not truncate at exactly the limit', () => {
    expect(toolPreview(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c, d, e');
  });
});

describe('the empty case says the right thing for its source', () => {
  it('does not blame the FILES when the files are what we did not read', async () => {
    // A smaller version of the #723 shape: a sentence about our source
    // presented as a fact about the user's setup — and on this path the footer
    // that used to correct it is deliberately gone.
    useStatus(ok([]));
    await mount();
    expect(text()).toContain('This session has no MCP servers');
    expect(text()).not.toContain("session's files");
  });

  it('still blames the files on the config path, where that is true', async () => {
    await mount('C:/p/acme', null);
    expect(text()).toContain("session's files");
  });
});

describe('runtimeStatus — the word for one row', () => {
  it.each([
    ['connected', 'connected'],
    ['pending', 'pending'],
    ['failed', 'failed'],
    ['needs-auth', 'pending'],
    ['unknown', 'unknown'],
  ])('maps %s to the %s token', (status, token) => {
    // `pending` reuses the needs-input hue rather than the failure one: a server
    // mid-handshake is a "wait", not a "wrong", and it is on screen for five
    // seconds of every fresh session.
    expect(runtimeStatus(runtimeServer({ name: 'x', status: status as never })).token).toBe(token);
  });
});
