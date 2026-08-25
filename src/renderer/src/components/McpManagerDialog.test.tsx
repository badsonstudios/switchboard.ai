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
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { McpManagerDialog, rowStatus } from './McpManagerDialog';
import { initI18nForTests } from '../i18n/test-i18n';
import type { McpHealthWire, McpInventoryWire, McpServerWire } from '../../../shared/mcp';

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
/** resolves the health call by hand, so "before it lands" is a real state */
let releaseHealth: (() => void) | null = null;

function installBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    mcp: {
      list: (folder: string) => Promise.resolve(listAnswer(folder)),
      health: (folder: string) =>
        new Promise((resolve) => {
          const fire = (): void => resolve(healthAnswer(folder));
          if (releaseHealth === null) fire();
          else releaseHealth = fire;
        }),
    },
  };
}

async function mount(folder: string | null = 'C:/p/acme'): Promise<void> {
  await act(async () => {
    root.render(<McpManagerDialog open onClose={() => {}} folder={folder} />);
  });
  // the list await
  await act(async () => {
    await Promise.resolve();
  });
}

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
  listAnswer = (folder) => ({ folder, servers: [], unreadable: [] });
  healthAnswer = (folder) => ({ folder, states: {} });
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
    healthAnswer = (folder) => ({ folder, states: { sentry: 'connected' } });

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

describe('a scope that could not be read (P6)', () => {
  it('is reported BESIDE the servers that read fine', async () => {
    // A `.mcp.json` with a trailing comma in it must not blank the user-scope
    // servers that are perfectly readable — and a silently empty section would
    // read as "you have none" rather than "we could not look".
    listAnswer = (folder) => ({
      folder,
      servers: [server({ name: 'mine', scope: 'user' })],
      unreadable: ['project'],
    });
    await mount();
    expect(rows().map((r) => r.dataset.mcpServer)).toEqual(['mine']);
    expect(host.querySelector('[data-mcp-section="project"]')).not.toBeNull();
    expect(text()).toContain('could not be read');
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
