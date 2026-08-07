// Persistent-group IPC (P2-E12-01, DESIGN "Persistent groups as containers"):
// CRUD over the WorkspaceStore's group records + session membership. All
// renderer input is validated here (§5.29) — ids are minted in the main
// process, never accepted from the renderer on create.
import { randomUUID } from 'crypto';
import { PersistedGroup, WorkspaceStore } from './store';
import { IpcBroker } from '../ipc/broker';

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

export function registerGroupIpc(store: WorkspaceStore, broker: IpcBroker): void {
  broker.handle('groups:list', () => store.listGroups());
  broker.handle('groups:palette', () => [...GROUP_PALETTE]);

  broker.handle('groups:create', (_e, opts: { name: string; color?: string }) => {
    const name = cleanName(opts?.name);
    if (!name) throw new Error('group needs a name');
    if (opts?.color !== undefined && !isColor(opts.color)) throw new Error('color must be #rrggbb');
    const color = opts?.color ?? GROUP_PALETTE[store.listGroups().length % GROUP_PALETTE.length];
    const group: PersistedGroup = { id: randomUUID(), name, color };
    store.upsertGroup(group);
    return group;
  });

  broker.handle('groups:update',
    (_e, id: string, patch: { name?: string; color?: string; notifyScope?: string }) => {
      if (typeof id !== 'string') return null;
      const prior = store.listGroups().find((g) => g.id === id);
      if (!prior) return null;
      const next: PersistedGroup = { ...prior };
      if (patch?.name !== undefined) {
        const name = cleanName(patch.name);
        if (!name) throw new Error('group name must be non-empty');
        next.name = name;
      }
      if (patch?.color !== undefined) {
        if (!isColor(patch.color)) throw new Error('color must be #rrggbb');
        next.color = patch.color;
      }
      if (patch?.notifyScope !== undefined) {
        if (!SCOPES.includes(patch.notifyScope as PersistedGroup['notifyScope']))
          throw new Error('bad notifyScope');
        next.notifyScope = patch.notifyScope as PersistedGroup['notifyScope'];
      }
      store.upsertGroup(next);
      return next;
    }
  );

  broker.handle('groups:delete', (_e, id: string) => {
    if (typeof id !== 'string') return;
    store.removeGroup(id);
  });

  broker.handle('groups:setSessionGroup', (_e, cardId: string, groupId: string | null) => {
    if (typeof cardId !== 'string') return;
    if (groupId !== null && typeof groupId !== 'string') return;
    store.setSessionGroup(cardId, groupId);
  });
}
