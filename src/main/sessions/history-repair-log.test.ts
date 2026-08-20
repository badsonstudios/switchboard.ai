import { describe, expect, it, vi } from 'vitest';
import { HistoryRepairLog, HistoryRepairStore } from './history-repair-log';
import {
  HistoryRepairNotice,
  MAX_HISTORY_REPAIR_NOTICES,
} from '../../shared/history-repair';

/** the workspace file, as this class sees it */
function fakeStore(): HistoryRepairStore & { held: HistoryRepairNotice[] } {
  const s = {
    held: [] as HistoryRepairNotice[],
    listHistoryRepairs: () => s.held.map((n) => ({ ...n })),
    setHistoryRepairs: (notices: HistoryRepairNotice[]) => {
      s.held = notices.map((n) => ({ ...n }));
    },
  };
  return s;
}

const adopted = (cardId: string, conv = 'conv') =>
  ({ kind: 'adopted', cardId, cardTitle: cardId, nativeSessionId: conv }) as const;

describe('HistoryRepairLog', () => {
  it('holds what happened before a window existed, and pushes what comes after', () => {
    const pushed: HistoryRepairNotice[] = [];
    const log = new HistoryRepairLog(fakeStore(), (n) => pushed.push(n));
    log.add({ kind: 'ceded', cardId: 'b', cardTitle: 'B', nativeSessionId: 'x', keptByTitle: 'A' });
    expect(log.list()).toEqual([
      {
        id: 'ceded:b:x',
        kind: 'ceded',
        cardId: 'b',
        cardTitle: 'B',
        nativeSessionId: 'x',
        keptByTitle: 'A',
      },
    ]);
    expect(pushed).toEqual(log.list());
  });

  it('SURVIVES the run — the list is the store, not this object', () => {
    // the whole reason it is persisted: a notice behind a collapsed drawer that
    // the user never opened must still be there next launch
    const store = fakeStore();
    new HistoryRepairLog(store).add(adopted('a'));
    expect(new HistoryRepairLog(store).list()).toHaveLength(1);
  });

  it('re-observing the same repair is a no-op, not a second row', () => {
    // the id is derived from the fact, so a launch that saw the same cede again
    // must not stack it up
    const store = fakeStore();
    const log = new HistoryRepairLog(store, () => {});
    log.add(adopted('a'));
    log.add(adopted('a'));
    expect(log.list()).toHaveLength(1);
  });

  it('does not announce a repair it did not record', () => {
    const pushed: HistoryRepairNotice[] = [];
    const log = new HistoryRepairLog(fakeStore(), (n) => pushed.push(n));
    log.add(adopted('a'));
    log.add(adopted('a'));
    expect(pushed).toHaveLength(1);
  });

  it('keeps one card’s two repairs apart', () => {
    // a card can cede one conversation and adopt another, or cede two
    const log = new HistoryRepairLog(fakeStore());
    log.add(adopted('a', 'conv-1'));
    log.add(adopted('a', 'conv-2'));
    expect(log.list().map((n) => n.id)).toEqual(['adopted:a:conv-1', 'adopted:a:conv-2']);
  });

  it('a dismissal reaches the store, not just this object', () => {
    // it has to outlive the run for the same reason the notice does: a
    // dismissal undone by a restart is a notice that comes back for ever
    const store = fakeStore();
    const log = new HistoryRepairLog(store);
    log.add(adopted('a'));
    log.dismiss('adopted:a:conv');
    expect(log.list()).toEqual([]);
    expect(store.held).toEqual([]);
    expect(new HistoryRepairLog(store).list()).toEqual([]);
  });

  it('shrugs at an unknown dismissal', () => {
    const log = new HistoryRepairLog(fakeStore());
    log.add(adopted('a'));
    expect(() => log.dismiss('nope')).not.toThrow();
    expect(log.list()).toHaveLength(1);
  });

  it('hands out copies — this is a record, not a queue', () => {
    const log = new HistoryRepairLog(fakeStore());
    log.add(adopted('a'));
    log.list()[0].cardTitle = 'tampered';
    expect(log.list()[0].cardTitle).toBe('a');
  });

  it('stops at the cap rather than rotating a notice off the screen', () => {
    const log = new HistoryRepairLog(fakeStore());
    for (let i = 0; i < MAX_HISTORY_REPAIR_NOTICES + 5; i++) log.add(adopted(`card-${i}`));
    expect(log.list()).toHaveLength(MAX_HISTORY_REPAIR_NOTICES);
    // the FIRST ones are kept: the user must not watch a notice they have not
    // read get replaced
    expect(log.list()[0].cardId).toBe('card-0');
  });

  it('keeps the record when the push throws — announcing must not cost it (P6)', () => {
    const boom = vi.fn(() => {
      throw new Error('window gone');
    });
    const log = new HistoryRepairLog(fakeStore(), boom);
    expect(() => log.add(adopted('a'))).not.toThrow();
    expect(log.list()).toHaveLength(1);
  });
});
