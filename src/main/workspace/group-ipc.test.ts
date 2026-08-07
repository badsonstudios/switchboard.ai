// What the group IPC seam will and will not write (#311), and HOW it says no
// (#326).
//
// `group-ipc.ts` had no test file at all, which is how the rail's unguarded
// rename draft (#294's worker found it, #311 fixed it) could look like a
// persisted-`''` bug for a while: nothing here stated out loud that main
// already refuses one. It does — `cleanName` trims and rejects — and that is
// the half of the rule the renderer cannot be trusted with, because the field
// is one caller and a §5.23 contribution or a future context-menu rename is
// another. Delete either half of `cleanName` and this file goes red.
//
// #326 changed the ANSWER, not the rule: a refused mutation resolves `null`
// with a line in the log instead of throwing, so an uncaught bridge call in the
// renderer (which is every bridge call in App.tsx) cannot turn an ordinary UI
// gesture into an unhandled rejection. The refusal assertions below are
// therefore "returned null AND wrote nothing AND said so", which is strictly
// more than "threw" — the `written` and name-unchanged assertions from #311 are
// untouched, because the guard itself is untouched.
//
// The store is a stand-in rather than a real `WorkspaceStore`: the claim under
// test is what the handler decides to hand it, so what it is handed is what
// gets asserted (the shape `sessions/ipc.test.ts` settled on for #294).
import { describe, it, expect, beforeEach } from 'vitest';
import { registerGroupIpc, GROUP_PALETTE } from './group-ipc';
import { PersistedGroup, WorkspaceStore } from './store';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';

type Handler = (e: unknown, ...args: unknown[]) => unknown;

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  fields?: LogFields;
}

interface Harness {
  call: (channel: string, ...args: unknown[]) => unknown;
  /** every group the handler chose to write, in order */
  written: PersistedGroup[];
  /** what the store would report on the next read */
  groups: PersistedGroup[];
  /** everything the handler said out loud */
  logs: LogLine[];
  /** the warnings only — a refusal is a warning, by contract (#326) */
  warnings: string[];
  /** the ids of sessions moved, so `setSessionGroup`'s guards are observable */
  moved: Array<{ cardId: string; groupId: string | null }>;
  /** the ids handed to removeGroup */
  removed: string[];
}

/** `registerGroupIpc` wired to a captured broker, store and log. */
function harness(prior: PersistedGroup[] = []): Harness {
  const handlers = new Map<string, Handler>();
  const written: PersistedGroup[] = [];
  const groups = [...prior];
  const logs: LogLine[] = [];
  const moved: Array<{ cardId: string; groupId: string | null }> = [];
  const removed: string[] = [];
  const broker = {
    handle: (channel: string, fn: Handler) => {
      if (handlers.has(channel)) throw new Error(`${channel} registered twice`);
      handlers.set(channel, fn);
    },
  } as unknown as IpcBroker;
  const store = {
    listGroups: () => groups.map((g) => ({ ...g })),
    upsertGroup: (g: PersistedGroup) => {
      written.push({ ...g });
      const i = groups.findIndex((x) => x.id === g.id);
      if (i >= 0) groups[i] = { ...g };
      else groups.push({ ...g });
    },
    removeGroup: (id: string) => removed.push(id),
    setSessionGroup: (cardId: string, groupId: string | null) => moved.push({ cardId, groupId }),
  } as unknown as WorkspaceStore;
  const record =
    (level: LogLine['level']) =>
    (msg: string, fields?: LogFields): void => {
      logs.push({ level, msg, fields });
    };
  const log: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => log,
  };

  registerGroupIpc(store, broker, log);
  return {
    written,
    groups,
    logs,
    moved,
    removed,
    get warnings() {
      return logs.filter((l) => l.level === 'warn').map((l) => l.msg);
    },
    call: (channel, ...args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`nothing registered on ${channel}`);
      return fn({}, ...args);
    },
  };
}

const EXISTING: PersistedGroup = { id: 'g1', name: 'infra', color: '#4a90d9' };

describe('a group name is never blank, coming or going (#311)', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness([EXISTING]);
  });

  /** the name the store would report for g1 after the call */
  const nameNow = (): string => h.groups.find((g) => g.id === 'g1')!.name;

  it('refuses an empty name, and writes nothing at all', () => {
    expect(h.call('groups:update', 'g1', { name: '' })).toBeNull();
    expect(h.written).toEqual([]);
    expect(nameNow()).toBe('infra');
  });

  it('refuses a whitespace-only name for the same reason', () => {
    expect(h.call('groups:update', 'g1', { name: '  \t ' })).toBeNull();
    expect(h.written).toEqual([]);
    expect(nameNow()).toBe('infra');
  });

  it('refuses a name that is not a string', () => {
    expect(h.call('groups:update', 'g1', { name: 42 })).toBeNull();
    expect(h.written).toEqual([]);
    expect(nameNow()).toBe('infra');
  });

  it('trims the name it does accept — so "blank" is one rule and not two', () => {
    h.call('groups:update', 'g1', { name: '  platform  ' });
    expect(h.written.map((g) => g.name)).toEqual(['platform']);
    expect(nameNow()).toBe('platform');
  });

  it('caps a long name at 60 characters', () => {
    h.call('groups:update', 'g1', { name: 'W'.repeat(200) });
    expect(nameNow()).toBe('W'.repeat(60));
  });

  it('leaves the name alone when the patch is not about the name', () => {
    // the guard must not fire on a recolor — `name: undefined` is "no change",
    // which is a different thing from "the empty name"
    h.call('groups:update', 'g1', { color: '#3aa675' });
    expect(nameNow()).toBe('infra');
    expect(h.written.map((g) => g.color)).toEqual(['#3aa675']);
    expect(h.warnings).toEqual([]);
  });

  it('ignores a rename aimed at a group that is not there', () => {
    expect(h.call('groups:update', 'nope', { name: 'x' })).toBeNull();
    expect(h.written).toEqual([]);
  });

  it('refuses to CREATE a group with a blank name, by the same rule', () => {
    expect(h.call('groups:create', { name: '   ' })).toBeNull();
    expect(h.written).toEqual([]);
  });

  it('trims the name of a group it does create, and gives it a palette color', () => {
    const made = h.call('groups:create', { name: '  new group  ' }) as PersistedGroup;
    expect(made.name).toBe('new group');
    expect(GROUP_PALETTE).toContain(made.color);
  });
});

describe('a refused group mutation answers null and says why — it never throws (#326)', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness([EXISTING]);
  });

  // The property the issue is actually about. `groups:*` was the ONE ipc family
  // whose handlers threw on validation, and App.tsx catches nothing, so an
  // ordinary UI gesture could raise an unhandled renderer rejection. Every
  // refusal this seam can produce is enumerated here; add a `throw` back to any
  // branch of `group-ipc.ts` and the matching row goes red.
  const REFUSALS: Array<[string, unknown[]]> = [
    ['an empty rename', ['groups:update', 'g1', { name: '' }]],
    ['a whitespace rename', ['groups:update', 'g1', { name: ' \t ' }]],
    ['a non-string name', ['groups:update', 'g1', { name: 42 }]],
    ['a color that is not #rrggbb', ['groups:update', 'g1', { color: 'red' }]],
    ['a short-hex color', ['groups:update', 'g1', { color: '#fff' }]],
    ['an unknown notify scope', ['groups:update', 'g1', { notifyScope: 'loud' }]],
    ['a non-string id', ['groups:update', 42, { name: 'x' }]],
    ['a create with no name', ['groups:create', { name: '' }]],
    ['a create with a bad color', ['groups:create', { name: 'ok', color: 'rebeccapurple' }]],
    ['a delete with a non-string id', ['groups:delete', 42]],
    ['a membership move with a non-string card', ['groups:setSessionGroup', 42, 'g1']],
    ['a membership move to a non-string group', ['groups:setSessionGroup', 'c1', 7]],
  ];

  it.each(REFUSALS)('does not throw on %s', (_what, args) => {
    const [channel, ...rest] = args as [string, ...unknown[]];
    expect(() => h.call(channel, ...rest)).not.toThrow();
  });

  it.each(REFUSALS)('warns, with the channel named, on %s', (_what, args) => {
    const [channel, ...rest] = args as [string, ...unknown[]];
    h.call(channel, ...rest);
    // not silently swallowed: exactly one warning, and it names the channel so
    // a log reader can find the call that was thrown away
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain(channel);
  });

  it('answers null — not undefined — for a refused create, so "nothing changed" is readable', () => {
    expect(h.call('groups:create', { name: '', color: '#3aa675' })).toBeNull();
    expect(h.written).toEqual([]);
  });

  it('answers null for a refused color, leaving the group exactly as it was', () => {
    expect(h.call('groups:update', 'g1', { color: 'not-a-color' })).toBeNull();
    expect(h.written).toEqual([]);
    expect(h.groups.find((g) => g.id === 'g1')).toEqual(EXISTING);
  });

  it('answers null for a refused notify scope, writing nothing', () => {
    expect(h.call('groups:update', 'g1', { notifyScope: 'shouty' })).toBeNull();
    expect(h.written).toEqual([]);
  });

  it('refuses PARTIALLY-bad patches whole — a good name does not smuggle a bad color in', () => {
    expect(h.call('groups:update', 'g1', { name: 'platform', color: 'octarine' })).toBeNull();
    expect(h.written).toEqual([]);
    expect(h.groups.find((g) => g.id === 'g1')!.name).toBe('infra');
  });

  it('drops a delete and a move it cannot understand, instead of writing junk', () => {
    h.call('groups:delete', 42);
    h.call('groups:setSessionGroup', 42, 'g1');
    h.call('groups:setSessionGroup', 'c1', 7);
    expect(h.removed).toEqual([]);
    expect(h.moved).toEqual([]);
  });

  it('still does the work it accepts — the guards are not a blanket refusal', () => {
    expect(h.call('groups:update', 'g1', { name: 'platform', color: '#3aa675' })).toEqual({
      id: 'g1',
      name: 'platform',
      color: '#3aa675',
    });
    h.call('groups:update', 'g1', { notifyScope: 'muted' });
    h.call('groups:delete', 'g1');
    h.call('groups:setSessionGroup', 'c1', 'g1');
    h.call('groups:setSessionGroup', 'c1', null);
    expect(h.removed).toEqual(['g1']);
    expect(h.moved).toEqual([
      { cardId: 'c1', groupId: 'g1' },
      { cardId: 'c1', groupId: null },
    ]);
    expect(h.warnings).toEqual([]);
  });

  it('does not WARN about a group that simply is not there — that is a race, not a bug', () => {
    // a group deleted in another window while this edit was open lands here;
    // there is nothing to fix, so it gets a debug line and not a warning
    expect(h.call('groups:update', 'gone', { name: 'x' })).toBeNull();
    expect(h.warnings).toEqual([]);
    expect(h.logs.filter((l) => l.level === 'debug')).toHaveLength(1);
  });
});
