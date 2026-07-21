// Persistent-group IPC (P2-E12-01, DESIGN "Persistent groups as containers"):
// CRUD over the WorkspaceStore's group records + session membership. All
// renderer input is validated here (§5.29) — ids are minted in the main
// process, never accepted from the renderer on create.
import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { PersistedGroup, WorkspaceStore } from './store';

const NAME_MAX = 60;
const SCOPES: ReadonlyArray<PersistedGroup['notifyScope']> = ['all', 'important', 'muted'];

/** #rrggbb only — the renderer picks from the theme palette. */
function isColor(c: unknown): c is string {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
}

function cleanName(n: unknown): string | null {
  if (typeof n !== 'string') return null;
  const t = n.trim().slice(0, NAME_MAX);
  return t.length > 0 ? t : null;
}

export function registerGroupIpc(store: WorkspaceStore): void {
  ipcMain.handle('groups:list', () => store.listGroups());

  ipcMain.handle('groups:create', (_e, opts: { name: string; color: string }) => {
    const name = cleanName(opts?.name);
    if (!name || !isColor(opts?.color)) throw new Error('group needs a name and a #rrggbb color');
    const group: PersistedGroup = { id: randomUUID(), name, color: opts.color };
    store.upsertGroup(group);
    return group;
  });

  ipcMain.handle(
    'groups:update',
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

  ipcMain.handle('groups:delete', (_e, id: string) => {
    if (typeof id !== 'string') return;
    store.removeGroup(id);
  });

  ipcMain.handle('groups:setSessionGroup', (_e, cardId: string, groupId: string | null) => {
    if (typeof cardId !== 'string') return;
    if (groupId !== null && typeof groupId !== 'string') return;
    store.setSessionGroup(cardId, groupId);
  });
}
