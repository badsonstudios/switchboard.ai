// The renderer's shared data shapes.
//
// These lived on the components that happened to render them first, which made
// the STORE import from `components/` — the state layer depending on the view.
// The concrete cost was a "test the store without React" unit test that
// transitively pulled in React, react-i18next and a 700-line rail component to
// borrow three type names.
//
// This module imports nothing but TYPES from `src/shared` — the IPC wire
// shapes these rows are BUILT from (`App.tsx` maps `sessions:cards` straight
// into `RailSession`). An `import type` is erased entirely, so the "state layer
// must not depend on the view" property above is untouched; what it buys is
// that a row cannot describe a card more loosely than the channel that fills
// it. Components re-export from here so existing imports keep working.
import type { RailCardStatus } from '../../../shared/sessions';
import type { TransportKind } from '../../../shared/transport';

/** A session as the rail and the grid see it. */
export interface RailSession {
  id: string;
  title: string;
  folder?: string;
  accent?: string;
  badge?: string;
  /**
   * The card's status, straight off `sessions:cards` — `SessionStatus` or the
   * card-only 'suspended' (#618) — plus the one value that does NOT come off
   * that channel: 'not-started' (#687), which the store mints for a card whose
   * `sessions:create` was refused. Main has never heard of such a card, so it
   * can never report one; see `RailCardStatus` for why that is a separate type
   * from the wire's `CardStatus` rather than one wider union.
   *
   * It was `string` here, which is where the narrowing `sessions:cards` gained
   * in #618 was being thrown away again: `App.tsx` maps `c.status` into this
   * field, so every rail consumer downstream (`presentStatus`, `ladder.ts`,
   * `urgency.ts`) was reading a widened value and casting it back.
   *
   * `presentStatus` (`lib/rail-view.ts`) still takes a tolerant `string` ON
   * PURPOSE — it is the fail-open reader for a value that can also come from a
   * persisted blob written by an older build, and it answers `PRESENTATION.idle`
   * for anything it does not know. Narrow at the SOURCE, stay tolerant at the
   * paint.
   */
  status?: RailCardStatus;
  /** persistent-group membership (E12); undefined = ungrouped */
  groupId?: string;
  /** repo/folder auto-group key (E12-05); same key = same emergent group */
  autoKey?: string;
  /** the live session under this card, when running (events map by this) */
  liveId?: string;
  /** freeform task label (shown under the title in the Events panel) */
  taskLabel?: string;
  /**
   * The transport this card's NEXT session will run on (#397): its own choice,
   * else the env override, else the default. `undefined` means main did not
   * say, and callers must read that as the default — never as "Terminal".
   *
   * This is the CHOSEN transport, not the running one. They differ while a
   * transport change waits for a restart; `lib/trust-reach.ts` says why the
   * chosen one is the answer its question wants.
   */
  transport?: TransportKind;
}

/** A persistent group (E12). */
export interface RailGroup {
  id: string;
  name: string;
  color: string;
}

/** One attention event — the main-process EventFeed's view of a session. */
export interface EventDto {
  id: number;
  sessionId: string;
  kind: 'done' | 'ready' | 'needs-input' | 'needs-permission' | 'crashed';
  at: string;
}
