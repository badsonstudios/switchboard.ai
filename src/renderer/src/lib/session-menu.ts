// ONE session menu, in three places (#1281).
//
// Right-clicking a session offers the same things wherever the session is
// drawn: its row in the list on the left, its pill or row on the strip across
// the top, and its tab in the workspace. #1168 made the first two one menu by
// holding two hand-written lists to the same answer in a test; the tab is the
// third place, and a third copy is how the next item gets added to one and
// forgotten in the others. So the ITEMS are built here, once, and each place
// only says what running one means there (the rail moves focus one way, the
// strip another, the tab opens a rename box in itself).
//
// The tab's menu is LONGER, not different: it is every item the lists offer,
// with the same words, the same dimming and the same tick, plus the things
// that are about the tab (pop out, close the others beside it) and two that
// the owner asked for on the tab (Duplicate, and Fork beside it). The lists
// stay the short menu the owner picked in #1168.
//
// The rules the lists already had, kept exactly:
//   * Rename is dimmed for a session that never started (#687): main declines
//     the write for a card it has no record of, and an item must never be
//     offered and then do nothing.
//   * "Mark as seen" is there only while there is something to mark (#1219).
//   * Move to group is ABSENT when it could do nothing — no groups, or a
//     session that never started. One item unavailable right now dims; a
//     whole set that can do nothing goes.
import React from 'react';
import type { DockviewApi } from 'dockview-react';
import type { RailGroupMenuItem } from '../components/RailGroupMenu';
import type { RailGroup, RailSession } from '../model/types';

type Translate = (key: string, vars?: Record<string, unknown>) => string;

/** what the menu needs to know about the session it is for, read NOW */
export interface SessionMenuFacts {
  session: { id: string; title: string; status?: string; groupId?: string };
  groups: readonly RailGroup[];
  pinned: boolean;
  /** finished, and nobody has looked (#1219) */
  finished: boolean;
}

/** what running each shared item means in the place the menu was opened */
export interface SessionMenuRuns {
  diff: () => void;
  rename: () => void;
  pin: () => void;
  close: () => void;
  seen: () => void;
  /** `here` = the session is already in that group: the caller decides what
   *  choosing it again does (nothing, or just handing focus back) */
  move: (groupId: string | null, here: boolean) => void;
}

/** The menu the LISTS show (rail row, strip pill, strip row), in their order. */
export function sessionMenuItems(
  f: SessionMenuFacts,
  run: SessionMenuRuns,
  t: Translate
): RailGroupMenuItem[] {
  const s = f.session;
  const started = s.status !== 'not-started';
  return [
    { id: 'diff', label: t('rail.menuDiff'), can: true, run: run.diff },
    { id: 'rename', label: t('rail.menuRename'), can: started, run: run.rename },
    // the label says which way it will go — pinning a not-started card DOES
    // work (the pin set is renderer state), which is why it is not dimmed
    { id: 'pin', label: t(f.pinned ? 'rail.menuUnpin' : 'rail.menuPin'), can: true, run: run.pin },
    { id: 'close', label: t('rail.menuClose'), can: true, run: run.close },
    ...(f.finished ? [{ id: 'seen', label: t('rail.menuSeen'), can: true, run: run.seen }] : []),
    // one choice out of a known set: each of your groups, and none. The
    // current one is checked. Auto-groups are not here — their membership is
    // computed from the folder, so an entry for one would do nothing.
    ...(f.groups.length > 0 && started
      ? [
          ...f.groups.map(
            (g, i): RailGroupMenuItem => ({
              id: `move:${g.id}`,
              label: g.name,
              can: true,
              checked: s.groupId === g.id,
              ...(i === 0 ? { heading: t('rail.menuMove') } : {}),
              run: () => run.move(g.id, s.groupId === g.id),
            })
          ),
          {
            id: 'move:none',
            label: t('strip.menuNoGroup'),
            can: true,
            checked: !s.groupId,
            run: () => run.move(null, !s.groupId),
          },
        ]
      : []),
  ];
}

/** what only a TAB's menu offers; an absent entry is one that can never apply */
export interface SessionTabExtras {
  /** a fresh session in the same folder; absent when the card has no folder */
  duplicate?: () => void;
  /** a new session that continues this conversation; absent unless the fork
   *  experiment is on AND the session has a conversation id to fork from */
  fork?: () => void;
  /** pop out, or come back: `poppedOut` says which the label offers */
  popOut: { poppedOut: boolean; run: () => void };
  /** absent when the card has no folder */
  copyPath?: () => void;
  reveal?: { platform: string | undefined; run: () => void };
  /** dimmed when the tab is alone in its group */
  closeOthers: { can: boolean; run: () => void };
}

/** "Explorer" on Windows, "Finder" on a Mac, "file manager" elsewhere */
export function revealLabelKey(platform: string | undefined): string {
  if (platform === 'win32') return 'tabMenu.revealWindows';
  if (platform === 'darwin') return 'tabMenu.revealMac';
  return 'tabMenu.revealOther';
}

/**
 * The menu a SESSION'S TAB shows. Every item of `sessionMenuItems`, untouched,
 * placed in the tab's order: what you do to the session first (rename,
 * duplicate, fork), then what the lists offer, then where its window is, then
 * its folder, and closing last.
 */
export function sessionTabMenuItems(
  f: SessionMenuFacts,
  run: SessionMenuRuns,
  x: SessionTabExtras,
  t: Translate
): RailGroupMenuItem[] {
  const shared = sessionMenuItems(f, run, t);
  const take = (id: string): RailGroupMenuItem[] => shared.filter((i) => i.id === id);
  const moves = shared.filter((i) => i.id.startsWith('move:'));
  /** the first item of a section draws a hairline above it */
  const section = (items: RailGroupMenuItem[]): RailGroupMenuItem[] =>
    items.map((item, i) => (i === 0 && item.heading === undefined ? { ...item, divider: true } : item));
  return [
    ...take('rename'),
    ...(x.duplicate
      ? [{ id: 'duplicate', label: t('tabMenu.duplicate'), can: true, run: x.duplicate }]
      : []),
    ...(x.fork ? [{ id: 'fork', label: t('tabMenu.fork'), can: true, run: x.fork }] : []),
    ...section([...take('diff'), ...take('pin'), ...take('seen')]),
    ...moves,
    ...section([
      {
        id: 'popout',
        label: t(x.popOut.poppedOut ? 'tabMenu.dockIn' : 'tabMenu.popOut'),
        can: true,
        run: x.popOut.run,
      },
    ]),
    ...section([
      ...(x.copyPath ? [{ id: 'copy-path', label: t('tabMenu.copyPath'), can: true, run: x.copyPath }] : []),
      ...(x.reveal
        ? [{ id: 'reveal', label: t(revealLabelKey(x.reveal.platform)), can: true, run: x.reveal.run }]
        : []),
    ]),
    ...section([
      { id: 'close-others', label: t('tabMenu.closeOthers'), can: x.closeOthers.can, run: x.closeOthers.run },
      ...take('close'),
    ]),
  ];
}

/**
 * The short menu of a tab with no session behind it — a document, a diff, a
 * comparison. Nothing about sessions; `popOut` absent for a tab that has no
 * window of its own to go to.
 */
export function plainTabMenuItems(
  x: {
    close: () => void;
    closeOthers: { can: boolean; run: () => void };
    popOut?: { poppedOut: boolean; run: () => void };
  },
  t: Translate
): RailGroupMenuItem[] {
  return [
    { id: 'close', label: t('tabMenu.close'), can: true, run: x.close },
    { id: 'close-others', label: t('tabMenu.closeOthers'), can: x.closeOthers.can, run: x.closeOthers.run },
    ...(x.popOut
      ? [
          {
            id: 'popout',
            label: t(x.popOut.poppedOut ? 'tabMenu.dockIn' : 'tabMenu.popOut'),
            can: true,
            divider: true,
            run: x.popOut.run,
          },
        ]
      : []),
  ];
}

/**
 * What a TAB's menu can ask of the app (#1281). A workspace tab is drawn by
 * dockview from a component map handed over once, so it receives a panel's
 * props and nothing else; the gestures it shares with the lists (rename, open
 * changes, move, pin) are App's, and the naming step for a new session is the
 * grid's. Both reach it through this context, which flows into dockview's
 * portals — popped-out windows included — the way `EmptyWorkspaceActions` does.
 *
 * `null` outside a provider: the menu still opens, and an item that needs one
 * of these simply does nothing (fail-open; only unit fakes mount it bare).
 */
export interface SessionMenuActions {
  rename: (cardId: string, name: string) => void;
  diff: (session: RailSession) => void;
  moveToGroup: (cardId: string, groupId: string | null) => void;
  togglePin: (cardId: string) => void;
  /** the naming dialog every human new session goes through (#1282) */
  askName?: (
    folder: string,
    place: { into: DockviewApi['groups'][number] | null; groupId?: string }
  ) => Promise<void>;
}

export const SessionMenuActionsContext = React.createContext<SessionMenuActions | null>(null);
