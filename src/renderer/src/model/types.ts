// The renderer's shared data shapes.
//
// These lived on the components that happened to render them first, which made
// the STORE import from `components/` — the state layer depending on the view.
// The concrete cost was a "test the store without React" unit test that
// transitively pulled in React, react-i18next and a 700-line rail component to
// borrow three type names.
//
// This module imports nothing. Components re-export from here so existing
// imports keep working.

/** A session as the rail and the grid see it. */
export interface RailSession {
  id: string;
  title: string;
  folder?: string;
  accent?: string;
  badge?: string;
  status?: string;
  /** persistent-group membership (E12); undefined = ungrouped */
  groupId?: string;
  /** repo/folder auto-group key (E12-05); same key = same emergent group */
  autoKey?: string;
  /** the live session under this card, when running (events map by this) */
  liveId?: string;
  /** freeform task label (shown under the title in the Events panel) */
  taskLabel?: string;
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
