// The renderer's one copy of "which AIs exist" (#1292): first fetch, pushes,
// and fail-open.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AisSnapshot } from '../../../shared/ais';
import { ipcRefusal } from '../../../shared/ipc/refusal';
import {
  acceptAisDefault,
  acceptAisSnapshot,
  getAisView,
  refreshAis,
  resetAisStoreForTests,
  startAis,
  subscribeAis,
} from './ais-store';

const g = globalThis as { switchboard?: unknown };

const snapshot = (id: string, detecting = false): AisSnapshot => ({
  items: [{ kind: 'provider', entry: { id, name: id }, providerId: id, registered: true }],
  default: { id, fellBack: false },
  detecting,
});

function bridge(over: Record<string, unknown> = {}) {
  let push: ((s: AisSnapshot) => void) | null = null;
  const b = {
    list: vi.fn(async () => snapshot('a').items),
    default: vi.fn(async () => snapshot('a').default),
    onChanged: vi.fn((cb: (s: AisSnapshot) => void) => {
      push = cb;
      return () => {
        push = null;
      };
    }),
    ...over,
  };
  g.switchboard = { ais: b };
  return { b, push: (s: AisSnapshot) => push?.(s) };
}

beforeEach(() => resetAisStoreForTests());
afterEach(() => {
  resetAisStoreForTests();
  delete g.switchboard;
});

describe('ais-store', () => {
  it('fetches once, however many readers start it, then follows the pushes', async () => {
    const { b, push } = bridge();
    startAis();
    startAis();
    await vi.waitFor(() => expect(getAisView().snapshot).not.toBeNull());
    expect(b.list).toHaveBeenCalledTimes(1);
    expect(b.onChanged).toHaveBeenCalledTimes(1);
    expect(getAisView().snapshot!.default.id).toBe('a');
    const seen = vi.fn();
    subscribeAis(seen);
    push(snapshot('b', true));
    expect(getAisView().snapshot!.default.id).toBe('b');
    expect(getAisView().snapshot!.detecting).toBe(true);
    expect(seen).toHaveBeenCalled();
  });

  it('a push that lands while the first fetch is in flight is newer, and wins', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { push } = bridge({
      list: vi.fn(async () => {
        await gate;
        return snapshot('old').items;
      }),
      default: vi.fn(async () => snapshot('old').default),
    });
    startAis();
    push(snapshot('new'));
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(getAisView().snapshot!.default.id).toBe('new');
  });

  it('FAIL-OPEN: a failed refresh keeps the last snapshot and says it failed', async () => {
    const { push } = bridge();
    startAis();
    await vi.waitFor(() => expect(getAisView().snapshot).not.toBeNull());
    push(snapshot('kept'));
    (g.switchboard as { ais: { list: () => Promise<unknown> } }).ais.list = async () => {
      throw new Error('gone');
    };
    await refreshAis();
    expect(getAisView().failed).toBe(true);
    expect(getAisView().snapshot!.default.id).toBe('kept');
  });

  it('a refusal is a failure, not a snapshot', () => {
    bridge();
    acceptAisSnapshot(snapshot('a'));
    acceptAisSnapshot(ipcRefusal('ais:lookAgain', 'capability-not-held'));
    expect(getAisView()).toMatchObject({ failed: true, snapshot: { default: { id: 'a' } } });
  });

  it('no bridge at all: nothing to show, and it says so', () => {
    startAis();
    expect(getAisView()).toEqual({ snapshot: null, failed: true });
  });

  it('a new default is taken before the push arrives', () => {
    acceptAisSnapshot(snapshot('a'));
    acceptAisDefault({ id: 'b', chosen: 'b', fellBack: false });
    expect(getAisView().snapshot!.default.id).toBe('b');
  });
});
