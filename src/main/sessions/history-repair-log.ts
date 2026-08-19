// The one place the app remembers what it repaired about a card's history
// (#539) — and the only thing that makes those repairs sayable on screen.
//
// Two producers, one list, because to the user they are one sentence ("your
// card's conversation was changed and nobody asked you"): the workspace load's
// duplicate untangle (`untangle.ts`, via `WorkspaceStore.listUntangled`) and a
// session start that adopted a conversation (`start-plan.ts`'s `resumedVia:
// 'adopted'`, via the session IPC). The first happens before any window exists
// and the second long after, which is why this both HOLDS a list a mounting
// window can ask for and PUSHES what arrives later.
//
// It owns no storage of its own. The list lives in the workspace file, because a
// repair the user has not seen yet has to survive them quitting without opening
// the drawer — the reasoning is written out on `HistoryRepairNotice`. This class
// is the read-modify-write plus the dedupe, the cap and the announcement.
import {
  HistoryRepairNotice,
  historyRepairId,
  MAX_HISTORY_REPAIR_NOTICES,
} from '../../shared/history-repair';

/** Everything but the id, which is derived rather than supplied. */
export type HistoryRepair = Omit<HistoryRepairNotice, 'id'>;

/** The persistence this needs, and nothing else — so the tests can hold a list
 *  in an array and the app can hold it in the workspace file. */
export interface HistoryRepairStore {
  listHistoryRepairs(): HistoryRepairNotice[];
  setHistoryRepairs(notices: HistoryRepairNotice[]): void;
}

export class HistoryRepairLog {
  /** `onAdded` is the push to a live window; absent while there is none. */
  constructor(
    private readonly store: HistoryRepairStore,
    private readonly onAdded?: (notice: HistoryRepairNotice) => void
  ) {}

  /**
   * Record a repair, and tell anyone listening.
   *
   * A repair already on the list is a NO-OP, not a duplicate: the id is derived
   * from the fact, so the same cede re-observed on a later launch is the same
   * notice. That is also what makes a dismissal final — nothing re-adds it,
   * because by then the state that produced it is gone.
   *
   * Silently DROPPED past the cap rather than rotated: the notice slot is a
   * corner of the events drawer, a workspace with eleven simultaneous history
   * repairs has a bigger problem than the eleventh notice, and both producers
   * already write every one of them to the log. Rotating would also mean a user
   * watching the screen sees a notice replace one they had not read.
   */
  add(repair: HistoryRepair): void {
    const notice: HistoryRepairNotice = { ...repair, id: historyRepairId(repair) };
    const held = this.list();
    if (held.some((n) => n.id === notice.id)) return;
    if (held.length >= MAX_HISTORY_REPAIR_NOTICES) return;
    this.store.setHistoryRepairs([...held, notice]);
    try {
      this.onAdded?.(notice);
    } catch {
      // A window that cannot be told still leaves the notice on the list for the
      // next `list()`. Failing to announce must never cost the record (P6).
    }
  }

  /** What a mounting window catches up on. */
  list(): HistoryRepairNotice[] {
    return this.store.listHistoryRepairs();
  }

  /**
   * "I have read this." The only way one leaves — and it leaves for good,
   * because a repair is one-time and nothing will produce it again.
   *
   * An unknown id is not an error: a second window, or a click that raced
   * another one, is allowed to say it twice.
   */
  dismiss(id: string): void {
    const held = this.list();
    const kept = held.filter((n) => n.id !== id);
    if (kept.length !== held.length) this.store.setHistoryRepairs(kept);
  }
}
