// The hand-off's carrier between the card that starts it and the card that
// receives it (#851). It decides nothing about context; what it must get right
// is WHO takes a request, that it is taken ONCE, and that it does not linger.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  HANDOFF_TTL_MS,
  closeHandoffPicker,
  handoffPickerCard,
  handoffTargets,
  openHandoffPicker,
  pendingHandoff,
  requestHandoff,
  resetHandoffForTests,
  subscribeHandoff,
  takeHandoff,
  takeLatestHandoff,
} from './context-handoff';

beforeEach(() => resetHandoffForTests());

describe('the picker', () => {
  it('opens on one card at a time, and closing forgets it', () => {
    openHandoffPicker('a');
    openHandoffPicker('b');
    expect(handoffPickerCard()).toBe('b');
    closeHandoffPicker();
    expect(handoffPickerCard()).toBeNull();
  });

  it('notifies on a change, and only on a change', () => {
    const l = vi.fn();
    subscribeHandoff(l);
    openHandoffPicker('a');
    openHandoffPicker('a');
    closeHandoffPicker();
    closeHandoffPicker();
    expect(l).toHaveBeenCalledTimes(2);
  });

  it('a pick closes it — the picker is done once a target is chosen', () => {
    openHandoffPicker('a');
    requestHandoff('b', 'live-a', 1_000);
    expect(handoffPickerCard()).toBeNull();
  });
});

describe('a request', () => {
  it('is taken by its TARGET only, and only once', () => {
    requestHandoff('b', 'live-a', 1_000);
    expect(takeHandoff('c', 1_000)).toBeNull();
    expect(takeHandoff(undefined, 1_000)).toBeNull();
    expect(takeHandoff('b', 1_000)).toBe('live-a');
    // a composer that re-mounts must not open the same dialog again
    expect(takeHandoff('b', 1_000)).toBeNull();
  });

  it('latest wins — a second pick replaces the first', () => {
    requestHandoff('b', 'live-a', 1_000);
    requestHandoff('c', 'live-a', 1_001);
    expect(takeHandoff('b', 1_001)).toBeNull();
    expect(takeHandoff('c', 1_001)).toBe('live-a');
  });

  it('⚠️ expires, so a target that never came up cannot open a dialog later', () => {
    requestHandoff('b', 'live-a', 1_000);
    expect(pendingHandoff(1_000 + HANDOFF_TTL_MS)).not.toBeNull();
    expect(takeHandoff('b', 1_000 + HANDOFF_TTL_MS + 1)).toBeNull();
    expect(pendingHandoff(1_000)).toBeNull(); // gone, not merely hidden
  });

  it('refuses to record half a request', () => {
    requestHandoff('', 'live-a', 1_000);
    requestHandoff('b', '', 1_000);
    expect(pendingHandoff(1_000)).toBeNull();
  });

  it('⚠️ the grid still sees a request a mounted composer TOOK first', () => {
    // listeners run in subscription order, so the target's composer can take
    // the request before the grid's listener runs — and the grid must still
    // bring that card forward
    requestHandoff('b', 'live-a', 1_000);
    expect(takeHandoff('b', 1_000)).toBe('live-a');
    expect(takeLatestHandoff()).toMatchObject({ target: 'b', fromLiveId: 'live-a' });
    // …once: a grid that re-mounts must not replay it on the next notify
    expect(takeLatestHandoff()).toBeNull();
  });

  it('tells subscribers, so a composer already on screen can answer it', () => {
    const l = vi.fn();
    subscribeHandoff(l);
    requestHandoff('b', 'live-a', 1_000);
    expect(l).toHaveBeenCalledOnce();
  });
});

describe('who the picker offers', () => {
  const live = (id: string, status?: string) => ({ id, liveId: `live-${id}`, status });

  it('every other running session, in rail order — the source is absent, as a self-drop is refused', () => {
    const rail = [live('a', 'idle'), live('b', 'working'), live('c')];
    expect(handoffTargets(rail, 'b').map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('nothing, when the source is the only session', () => {
    expect(handoffTargets([live('a')], 'a')).toEqual([]);
  });

  it('⚠️ never a card with no prompt box to land on — the drop could not reach it either', () => {
    const rail = [
      live('a', 'suspended'),
      live('b', 'not-started'),
      live('c', 'ended'),
      live('d', 'crashed'),
      { id: 'e', status: 'idle' }, // no live session at all
      live('f', 'needs-input'),
    ];
    expect(handoffTargets(rail, 'x').map((s) => s.id)).toEqual(['f']);
  });
});
