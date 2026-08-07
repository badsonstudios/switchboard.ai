// Persistent-group IPC (P2-E12-01, DESIGN "Persistent groups as containers"):
// CRUD over the WorkspaceStore's group records + session membership. All
// renderer input is validated here (§5.29) — ids are minted in the main
// process, never accepted from the renderer on create.
//
// HOW THIS SEAM SAYS NO (#326). It refuses by RESOLVING `null` and writing a
// line to the log, never by throwing. That is a deliberate choice over the
// alternative (leave the throws, add `.catch()` at the three call sites in
// App.tsx), and the reasoning is worth keeping because it decides how the NEXT
// caller behaves:
//
//   * A `.catch()` policy is safe by CONVENTION — it makes today's callers
//     safe and leaves tomorrow's (a context-menu rename, a §5.23 contribution,
//     `SessionGrid`'s own `setSessionGroup` call) safe only if whoever writes
//     them remembers. A result shape is safe by CONSTRUCTION: there is nothing
//     to remember, because there is nothing to reject.
//   * It is the house shape, and this file was already half-way into it —
//     `groups:update` has always declared `PersistedGroup | null` and always
//     returned `null` for a non-string or unknown id. Only the VALIDATION
//     branches threw, so the throws were the outlier inside this one file.
//     Elsewhere: `sessions:setTransport` answers `{ ok, reason }`,
//     `sessions:submitPrompt` and `sessions:interrupt` answer `false`.
//   * `null` is data, so the renderer can react to it (re-read the store, and
//     the field it just edited reverts to the truth). A rejection is not data;
//     the most a `.catch(log)` at the call site could do is stop the crash.
//   * A renderer-wide `unhandledrejection` handler would ALSO have stopped the
//     crash — and would have made #311's `pageerror` assertion in
//     `e2e/groups.spec.ts` vacuous by swallowing exactly what it watches for.
//     Rejected for that reason.
//
// What this does NOT change: the store still never sees a blank name, an
// untrimmed name, an over-long name, an off-format color or an unknown notify
// scope. Refusing is still refusing; it just no longer detonates in the caller.
// `group-ipc.test.ts` holds both halves — the refusal AND the log line.
//
// Residual, stated so nobody reads this as "groups can no longer reject": the
// broker (`ipc/broker.ts`) throws `refused: <channel>` for ANY channel whose
// caller lacks the capability, so no per-family shape can make a renderer
// rejection impossible in principle. Unreachable today (our one renderer holds
// every capability); a real question when Phase-4 plugins arrive.
import { randomUUID } from 'crypto';
import { PersistedGroup, WorkspaceStore } from './store';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';

const NAME_MAX = 60;
const SCOPES: ReadonlyArray<PersistedGroup['notifyScope']> = ['all', 'important', 'muted'];

/** Group color palette — owned here (persisted DATA, not renderer styling;
 *  the renderer's token rule bans raw colors in TSX). Legible on both themes. */
export const GROUP_PALETTE = [
  '#4a90d9',
  '#8f6fd8',
  '#3aa675',
  '#d98f3d',
  '#d95f6a',
  '#3fb6c4',
  '#c96fb0',
  '#a3a83e',
];

/** #rrggbb only — the renderer picks from the theme palette. */
function isColor(c: unknown): c is string {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
}

/**
 * A group's name, or `null` if what was offered is not one.
 *
 * THIS IS THE HALF OF THE RULE THAT SURVIVES A RESTART (#311), and it is the
 * reason the group case was never as bad as the session one #294 fixed: a
 * rename arriving from the rail with an empty draft has always died here, so
 * `''` has never been a persisted group name. Keep it even though the rail now
 * refuses a blank at the field — the field is one caller and it is the
 * renderer, and this is the seam a §5.23 contribution or a future context-menu
 * rename would otherwise walk straight through. `group-ipc.test.ts` fails if
 * either half is removed.
 */
function cleanName(n: unknown): string | null {
  if (typeof n !== 'string') return null;
  const t = n.trim().slice(0, NAME_MAX);
  return t.length > 0 ? t : null;
}

export function registerGroupIpc(store: WorkspaceStore, broker: IpcBroker, log: Logger): void {
  /**
   * Say no: `null` to the caller, one line in the log.
   *
   * The log line is the whole reason a result shape is not a silent swallow —
   * the seam still says out loud that it refused and why, in the one place
   * that knows why. Tests assert on it (#326 done-when 2).
   */
  const refuse = (channel: string, reason: string, fields: LogFields = {}): null => {
    log.warn(`${channel} refused: ${reason}`, fields);
    return null;
  };

  broker.handle('groups:list', () => store.listGroups());
  broker.handle('groups:palette', () => [...GROUP_PALETTE]);

  broker.handle('groups:create', (_e, opts: { name: string; color?: string }) => {
    const name = cleanName(opts?.name);
    if (!name) return refuse('groups:create', 'a group needs a non-empty name');
    if (opts?.color !== undefined && !isColor(opts.color))
      return refuse('groups:create', 'color must be #rrggbb');
    const color = opts?.color ?? GROUP_PALETTE[store.listGroups().length % GROUP_PALETTE.length];
    const group: PersistedGroup = { id: randomUUID(), name, color };
    store.upsertGroup(group);
    return group;
  });

  broker.handle('groups:update',
    (_e, id: string, patch: { name?: string; color?: string; notifyScope?: string }) => {
      if (typeof id !== 'string') return refuse('groups:update', 'id must be a string');
      const prior = store.listGroups().find((g) => g.id === id);
      // Not an error to shout about: a group deleted in another window while
      // this edit was open lands here, and there is nothing to fix.
      if (!prior) {
        log.debug('groups:update for an unknown group — ignored', { groupId: id });
        return null;
      }
      const next: PersistedGroup = { ...prior };
      if (patch?.name !== undefined) {
        const name = cleanName(patch.name);
        if (!name) return refuse('groups:update', 'group name must be non-empty', { groupId: id });
        next.name = name;
      }
      if (patch?.color !== undefined) {
        if (!isColor(patch.color))
          return refuse('groups:update', 'color must be #rrggbb', { groupId: id });
        next.color = patch.color;
      }
      if (patch?.notifyScope !== undefined) {
        if (!SCOPES.includes(patch.notifyScope as PersistedGroup['notifyScope']))
          return refuse('groups:update', 'unknown notifyScope', { groupId: id });
        next.notifyScope = patch.notifyScope as PersistedGroup['notifyScope'];
      }
      store.upsertGroup(next);
      return next;
    }
  );

  broker.handle('groups:delete', (_e, id: string) => {
    if (typeof id !== 'string') {
      refuse('groups:delete', 'id must be a string');
      return;
    }
    store.removeGroup(id);
  });

  broker.handle('groups:setSessionGroup', (_e, cardId: string, groupId: string | null) => {
    if (typeof cardId !== 'string') {
      refuse('groups:setSessionGroup', 'cardId must be a string');
      return;
    }
    if (groupId !== null && typeof groupId !== 'string') {
      refuse('groups:setSessionGroup', 'groupId must be a string or null', { cardId });
      return;
    }
    store.setSessionGroup(cardId, groupId);
  });
}
