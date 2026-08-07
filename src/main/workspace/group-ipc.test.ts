// What the group IPC seam will and will not write (#311).
//
// `group-ipc.ts` had no test file at all, which is how the rail's unguarded
// rename draft (#294's worker found it, #311 fixed it) could look like a
// persisted-`''` bug for a while: nothing here stated out loud that main
// already refuses one. It does — `cleanName` trims and rejects — and that is
// the half of the rule the renderer cannot be trusted with, because the field
// is one caller and a §5.23 contribution or a future context-menu rename is
// another. Delete either half of `cleanName` and this file goes red.
//
// The store is a stand-in rather than a real `WorkspaceStore`: the claim under
// test is what the handler decides to hand it, so what it is handed is what
// gets asserted (the shape `sessions/ipc.test.ts` settled on for #294).
import { describe, it, expect, beforeEach } from 'vitest';
import { registerGroupIpc, GROUP_PALETTE } from './group-ipc';
import { PersistedGroup, WorkspaceStore } from './store';
import { IpcBroker } from '../ipc/broker';

type Handler = (e: unknown, ...args: unknown[]) => unknown;

interface Harness {
  call: (channel: string, ...args: unknown[]) => unknown;
  /** every group the handler chose to write, in order */
  written: PersistedGroup[];
  /** what the store would report on the next read */
  groups: PersistedGroup[];
}

/** `registerGroupIpc` wired to a captured broker and an in-memory store. */
function harness(prior: PersistedGroup[] = []): Harness {
  const handlers = new Map<string, Handler>();
  const written: PersistedGroup[] = [];
  const groups = [...prior];
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
    removeGroup: () => {},
    setSessionGroup: () => {},
  } as unknown as WorkspaceStore;

  registerGroupIpc(store, broker);
  return {
    written,
    groups,
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
    // it THROWS rather than returning quietly, which is this module's idiom
    // (`groups:create` does the same) and is why the rail guard matters: the
    // renderer's `groups.update(...)` call is not caught, so an empty draft
    // reaching here surfaced as an unhandled rejection and no explanation.
    expect(() => h.call('groups:update', 'g1', { name: '' })).toThrow(/non-empty/);
    expect(h.written).toEqual([]);
    expect(nameNow()).toBe('infra');
  });

  it('refuses a whitespace-only name for the same reason', () => {
    expect(() => h.call('groups:update', 'g1', { name: '  \t ' })).toThrow(/non-empty/);
    expect(h.written).toEqual([]);
    expect(nameNow()).toBe('infra');
  });

  it('refuses a name that is not a string', () => {
    expect(() => h.call('groups:update', 'g1', { name: 42 })).toThrow(/non-empty/);
    expect(h.written).toEqual([]);
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
  });

  it('ignores a rename aimed at a group that is not there', () => {
    expect(h.call('groups:update', 'nope', { name: 'x' })).toBeNull();
    expect(h.written).toEqual([]);
  });

  it('refuses to CREATE a group with a blank name, by the same rule', () => {
    expect(() => h.call('groups:create', { name: '   ' })).toThrow(/needs a name/);
    expect(h.written).toEqual([]);
  });

  it('trims the name of a group it does create, and gives it a palette color', () => {
    const made = h.call('groups:create', { name: '  new group  ' }) as PersistedGroup;
    expect(made.name).toBe('new group');
    expect(GROUP_PALETTE).toContain(made.color);
  });
});
