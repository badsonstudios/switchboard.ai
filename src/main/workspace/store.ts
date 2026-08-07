// Workspace store (P1-E2-04, §5.25/§7): the single persisted picture of the
// workspace — session records (identity, layout slot, provider-native id for
// resume) and window geometry with a display fingerprint. Restore-on-launch
// yields SUSPENDED session records; actual relaunch is resume-on-focus
// (§5.25) — the UI layer (E3) turns a touched suspended card into
// SessionManager.create({...identity}, {resumeSessionId: nativeSessionId}).
//
// Persistence rules: tolerant load (corrupt file -> backed aside, fresh
// start — never crash on our own state), atomic save (tmp + rename),
// debounced save-soon for churny callers, and a version dispatch on the way in
// (§5.26) — a file from a FUTURE version is shown but never written back.
import fs from 'fs';
import path from 'path';
import { Rectangle } from 'electron';
import { Logger } from '../log/logger';
import { SessionIdentity } from '../sessions/session-manager';
import { WindowState, mergeState, isOnAnyDisplay } from '../window-state';
import { UpdatePrefs } from '../../shared/update';

export interface PersistedSession {
  id: string;
  identity: SessionIdentity;
  layoutSlot: number;
  nativeSessionId?: string;
  suspendedAt: string;
  /** last-known token totals + model, so usage survives a resume/restart */
  usage?: { input: number; output: number; cacheRead: number; cacheCreate: number };
  model?: string;
  /** autonomy mode this card runs at (stable across resumes) */
  autonomy?: 'plan' | 'ask' | 'auto-edit' | 'full-auto';
  /**
   * Which transport this card's sessions run on (P2-E18-08b).
   *
   * Absent = `pty`, which is every card that existed before E18 and every new
   * one: stream mode ships OPT-IN, the mirror image of the VS Code extension's
   * `claudeCode.useTerminal`. Stored per CARD, not per live session, so the
   * choice survives a resume the same way autonomy does.
   */
  transport?: 'pty' | 'stream';
  /** freeform "what is this doing" label, distinct from the folder title */
  taskLabel?: string;
  /** persistent-group membership (E12); absent/null = ungrouped */
  groupId?: string;
}

/**
 * A persistent group (E12, DESIGN "Persistent groups as containers"): a
 * durable first-class container — it exists independently of its members and
 * survives being empty. Distinct from emergent repo/folder auto-groups,
 * which are computed and never persisted.
 */
export interface PersistedGroup {
  id: string;
  name: string;
  color: string;
  /** notification scoping consumed by the E14 rules engine; stored now so the record is complete */
  notifyScope?: 'all' | 'important' | 'muted';
}

export interface PersistedWindow extends WindowState {
  displayFingerprint: string;
}

export interface NotificationPrefsState {
  enabled: boolean;
  quietStart?: string;
  quietEnd?: string;
  /** OS toast popups — opt-in, default OFF (Dan 2026-07-22) */
  osToasts?: boolean;
}

export interface WorkspaceState {
  version: 1;
  sessions: PersistedSession[];
  groups: PersistedGroup[];
  window: PersistedWindow | null;
  /** opaque grid-layout JSON owned by the renderer (Dockview serialization) */
  layout: unknown;
  /** opaque renderer-owned UI state (focus, per-card view tabs, prefs —
   *  §5.25). Lives here, not localStorage: the packaged renderer's loopback
   *  origin changes port per launch, so localStorage resets every run. */
  ui: unknown;
  notifications: NotificationPrefsState;
  /** auto-trust a folder on session open (picking a folder = trusting it) */
  autoTrust: boolean;
  /**
   * Update-check preferences (P2-E19-03). A top-level TYPED field rather than
   * a key in the opaque `ui` blob, because MAIN is the reader: the daily timer
   * and the skip decision run with no renderer involved, and the renderer
   * rewrites `ui` wholesale — which would clobber a `lastCheck` main had just
   * written.
   */
  updates: UpdatePrefs;
}

/** The schema version this build writes. Bump it and add a MIGRATIONS entry. */
export const CURRENT_VERSION = 1;

/**
 * Version dispatch (P2-E15-13, §5.26, AR-P2-9).
 *
 * Keyed by the version found IN THE FILE; each entry lifts that shape **all the
 * way to the current one** — entries are not chained. The field-by-field
 * sanitization in `load()` then runs unchanged: the migration decides *what the
 * fields mean*, the sanitizer decides *whether they are usable*. That
 * belt-and-braces split is deliberate — a migration can be wrong about a
 * hand-edited file, the sanitizer never is.
 *
 * There is exactly one version today, so the only entry is the identity, and
 * writing the hook now is free. **The rule when you add v2:** bump
 * `CURRENT_VERSION`, add `2: (raw) => raw` as the new identity, and rewrite
 * `1:` to lift a v1 file *directly* to v2 — every version below
 * `CURRENT_VERSION` keeps an entry, and each is rewritten (not composed) on the
 * next bump. Nothing outside this table moves.
 */
type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;
const MIGRATIONS: Record<number, Migration | undefined> = {
  1: (raw) => raw, // identity: v1 IS the current shape
};

/** No entry for this version (a future file, or a table gap): read it as-is. */
const passthrough: Migration = (raw) => raw;

/**
 * The file's declared version, normalized.
 *
 * Absent and `0` mean **v1** — that is what a file predating the field is. A
 * numeric STRING is coerced (`"2"` is a v2 file with a sloppy writer, and the
 * expensive mistake would be to call it v1 and overwrite it). Anything else
 * that cannot be a version — `null`, `"abc"`, an object — falls back to v1,
 * where the tolerant field-by-field reader can still make something of it.
 * Only a well-formed number ABOVE `CURRENT_VERSION` counts as "from the future".
 */
function detectVersion(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

const EMPTY: WorkspaceState = {
  version: CURRENT_VERSION,
  sessions: [],
  groups: [],
  window: null,
  layout: null,
  ui: null,
  notifications: { enabled: true, osToasts: false },
  autoTrust: true,
  updates: { autoCheck: true },
};

/** Stable identity for a display arrangement (§7). */
export function displayFingerprint(workAreas: Rectangle[]): string {
  return workAreas
    .map((a) => `${a.x},${a.y},${a.width},${a.height}`)
    .sort()
    .join('|');
}

/** A fresh empty state — never the shared `EMPTY`, whose arrays are mutable. */
function emptyState(): WorkspaceState {
  return {
    ...EMPTY,
    sessions: [],
    groups: [],
    notifications: { ...EMPTY.notifications },
    updates: { ...EMPTY.updates },
  };
}

export class WorkspaceStore {
  private state: WorkspaceState = emptyState();
  private saveTimer: NodeJS.Timeout | null = null;
  private readOnly = false;

  constructor(
    private readonly file: string,
    private readonly log?: Logger
  ) {}

  load(): WorkspaceState {
    this.readOnly = false;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // `null`, a bare number, an array: valid JSON, not a workspace. Throwing
      // here keeps the pre-existing corrupt-file path (back the corpse aside,
      // start fresh) — reading fields off it would just yield a silent empty
      // workspace and lose the post-mortem material.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('workspace file is not a JSON object');
      }
      const obj = parsed as Record<string, unknown>;
      const fileVersion = detectVersion(obj.version);
      if (fileVersion > CURRENT_VERSION) {
        // Written by a NEWER switchboard.ai. Fail-open says boot anyway, so we
        // read what we recognize — but saving would rewrite their file as a
        // lossy v1 and destroy whatever this build cannot see. So: display it,
        // never write it.
        this.readOnly = true;
        this.log?.warn(
          'workspace file was written by a newer version of switchboard.ai — loading it read-only; changes made this run will NOT be saved',
          { file: this.file, fileVersion, supportedVersion: CURRENT_VERSION }
        );
      }
      // Unknown future versions have no migration; fall through to the current
      // reader and let the sanitizer keep whatever still makes sense. (Nothing
      // below is reset in the `catch` on purpose: if the sanitizer ever chokes
      // on a future file, staying read-only is the safe half of the failure.)
      const raw = (MIGRATIONS[fileVersion] ?? passthrough)(obj) as Partial<WorkspaceState>;
      const groups = (Array.isArray(raw.groups) ? raw.groups.filter(isSaneGroup) : []).map((g) => {
        const repaired = repairGroupName(g);
        // identity compare: the repair hands BACK the same object when the
        // name was fine, so a new one means it stepped in
        if (repaired !== g)
          this.log?.warn('a group in the workspace file had a blank name — using a placeholder', {
            file: this.file,
            groupId: g.id,
            name: PLACEHOLDER_GROUP_NAME,
          });
        return repaired;
      });
      const groupIds = new Set(groups.map((g) => g.id));
      this.state = {
        version: CURRENT_VERSION,
        sessions: (Array.isArray(raw.sessions) ? raw.sessions.filter(isSaneSession) : []).map(
          // a dangling groupId (group gone, e.g. hand-edited file) degrades to ungrouped
          (s) => (s.groupId && !groupIds.has(s.groupId) ? { ...s, groupId: undefined } : s)
        ),
        groups,
        window: sanitizeWindow(raw.window),
        layout: raw.layout ?? null,
        ui: raw.ui ?? null,
        notifications: sanitizeNotifications(raw.notifications),
        autoTrust: raw.autoTrust !== false, // default on
        updates: sanitizeUpdates(raw.updates),
      };
    } catch (err) {
      // corrupt/missing: back the corpse aside (post-mortem material), start fresh
      if (fs.existsSync(this.file)) {
        try {
          fs.copyFileSync(this.file, `${this.file}.corrupt`);
        } catch {
          /* best-effort */
        }
      }
      this.state = emptyState();
      void err;
    }
    return this.snapshot();
  }

  snapshot(): WorkspaceState {
    return JSON.parse(JSON.stringify(this.state)) as WorkspaceState;
  }

  listSessions(): PersistedSession[] {
    return this.state.sessions.map((s) => JSON.parse(JSON.stringify(s)) as PersistedSession);
  }

  upsertSession(s: PersistedSession): void {
    const copy = JSON.parse(JSON.stringify(s)) as PersistedSession; // no shared refs with callers
    const i = this.state.sessions.findIndex((x) => x.id === s.id);
    if (i >= 0) this.state.sessions[i] = copy;
    else this.state.sessions.push(copy);
    this.saveSoon();
  }

  removeSession(id: string): void {
    this.state.sessions = this.state.sessions.filter((x) => x.id !== id);
    this.saveSoon();
  }

  listGroups(): PersistedGroup[] {
    return this.state.groups.map((g) => ({ ...g }));
  }

  upsertGroup(g: PersistedGroup): void {
    const copy = { ...g };
    const i = this.state.groups.findIndex((x) => x.id === g.id);
    if (i >= 0) this.state.groups[i] = copy;
    else this.state.groups.push(copy);
    this.saveSoon();
  }

  /** Delete a group; its members fall back to ungrouped (empty ≠ gone, delete = gone). */
  removeGroup(id: string): void {
    this.state.groups = this.state.groups.filter((g) => g.id !== id);
    for (const s of this.state.sessions) if (s.groupId === id) s.groupId = undefined;
    this.saveSoon();
  }

  /** Set (or clear, with null) a session card's group membership. */
  setSessionGroup(cardId: string, groupId: string | null): void {
    const s = this.state.sessions.find((x) => x.id === cardId);
    if (!s) return;
    if (groupId !== null && !this.state.groups.some((g) => g.id === groupId)) return; // unknown group: no-op
    s.groupId = groupId ?? undefined;
    this.saveSoon();
  }

  setWindow(w: PersistedWindow): void {
    this.state.window = w;
    this.saveSoon();
  }

  setLayout(layout: unknown): void {
    this.state.layout = layout;
    this.saveSoon();
  }

  getLayout(): unknown {
    return this.state.layout;
  }

  setUi(ui: unknown): void {
    this.state.ui = ui;
    this.saveSoon();
  }

  getUi(): unknown {
    return this.state.ui;
  }

  getNotificationPrefs(): NotificationPrefsState {
    return { ...this.state.notifications };
  }

  setNotificationPrefs(p: Partial<NotificationPrefsState>): void {
    // merge-patch semantics: the enabled-toggle must not reset osToasts /
    // quiet hours to defaults (review P1 #13 — replace-then-sanitize wiped
    // every pref the caller didn't send)
    this.state.notifications = sanitizeNotifications({ ...this.state.notifications, ...p });
    this.saveSoon();
  }

  getUpdatePrefs(): UpdatePrefs {
    return { ...this.state.updates };
  }

  /** Merge-patch, for the reason the notification prefs are (review P1 #13). */
  setUpdatePrefs(p: Partial<UpdatePrefs>): void {
    this.state.updates = sanitizeUpdates({ ...this.state.updates, ...p });
    this.saveSoon();
  }

  getAutoTrust(): boolean {
    return this.state.autoTrust;
  }

  setAutoTrust(on: boolean): void {
    this.state.autoTrust = on;
    this.saveSoon();
  }

  /**
   * Geometry to restore for the current display arrangement. A saved position
   * on a missing display rescues to centered-on-primary (bounds: null).
   */
  restoreWindow(currentWorkAreas: Rectangle[]): WindowState {
    const w = this.state.window;
    if (!w) return { bounds: null, isMaximized: false };
    const sameArrangement = w.displayFingerprint === displayFingerprint(currentWorkAreas);
    if (w.bounds && (sameArrangement || isOnAnyDisplay(w.bounds, currentWorkAreas))) {
      return { bounds: w.bounds, isMaximized: w.isMaximized };
    }
    return { bounds: null, isMaximized: w.isMaximized }; // rescue, keep maximized
  }

  /**
   * True when the loaded file came from a newer schema version than this build
   * understands. The workspace is usable in memory; nothing is persisted.
   */
  isReadOnly(): boolean {
    return this.readOnly;
  }

  save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.readOnly) return; // never downgrade a future-version file to v1
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // Persistence is best-effort — never take the app down (fail-open, P6).
      // But it was also SILENT, and this is the write that carries the whole
      // layout: every card, every group, every popped-out window. A failure
      // here means the next launch quietly restores a stale workspace with no
      // hint as to why, which is indistinguishable from the app forgetting on
      // purpose. It is exactly the kind of failure a busy machine produces —
      // on Windows the tmp+rename dance loses to a scanner or an indexer
      // holding the file for a moment (EPERM/EBUSY) — so say so (#165).
      this.log?.warn('workspace save failed — this run will not be restored', {
        file: this.file,
        error: String(err),
      });
    }
  }

  saveSoon(): void {
    if (this.readOnly) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 500);
    this.saveTimer.unref?.();
  }
}

function isSaneSession(s: unknown): s is PersistedSession {
  const x = s as Partial<PersistedSession>;
  return (
    typeof x?.id === 'string' &&
    typeof x?.identity?.folder === 'string' &&
    typeof x?.identity?.providerId === 'string' &&
    typeof x?.layoutSlot === 'number'
  );
}

function isSaneGroup(g: unknown): g is PersistedGroup {
  const x = g as Partial<PersistedGroup>;
  return typeof x?.id === 'string' && typeof x?.name === 'string' && typeof x?.color === 'string';
}

/**
 * Stand-in name for a group that arrived nameless (#327). Hardcoded English
 * like the rest of main (see `app-menu.ts`) — i18n lives in the renderer, and
 * this is DATA on its way into the store, not a rendered label.
 */
export const PLACEHOLDER_GROUP_NAME = 'Untitled group';

/**
 * Give a blank-named group a name on the way in (#327).
 *
 * `groups:create` and `groups:update` have always refused an empty name, so
 * this cannot come from the app — but a hand-edited or half-written
 * `workspace.json` can still carry `name: ""`, and the group's name IS its
 * button in the sessions rail: blank renders zero-width, and double-click to
 * rename lands on nothing. The invariant "no group has a blank name" has to
 * hold on the way in too, not only on the write paths.
 *
 * REPAIR, not reject. Dropping the group would take its membership with it —
 * every session inside it silently degrades to ungrouped (see the dangling-id
 * mapping in `load`) — so one bad field would cost the user real structure.
 * Fail-open (P6): the same call this file makes for a bad window rectangle or
 * a nonsense notification pref, which are sanitized rather than fatal.
 *
 * Only a BLANK name is touched. Padding is left exactly as written: the write
 * path trims, but a name with spaces around it still renders and still has
 * something to grab, and rewriting a user's file beyond the defect is not this
 * function's business.
 */
function repairGroupName(g: PersistedGroup): PersistedGroup {
  return g.name.trim().length > 0 ? g : { ...g, name: PLACEHOLDER_GROUP_NAME };
}

function sanitizeNotifications(n: unknown): NotificationPrefsState {
  if (typeof n !== 'object' || n === null) return { enabled: true };
  const x = n as Partial<NotificationPrefsState>;
  return {
    enabled: x.enabled !== false,
    osToasts: x.osToasts === true, // default OFF
    ...(typeof x.quietStart === 'string' ? { quietStart: x.quietStart } : {}),
    ...(typeof x.quietEnd === 'string' ? { quietEnd: x.quietEnd } : {}),
  };
}

/**
 * Update prefs, read tolerantly (P2-E19-03).
 *
 * `autoCheck` defaults ON, the same "!== false" shape as `autoTrust`. The two
 * string fields are dropped unless they really are non-empty strings: a
 * `skippedVersion` of `null` from a hand-edited file must not become the string
 * "null" and quietly suppress a release nobody skipped.
 */
function sanitizeUpdates(u: unknown): UpdatePrefs {
  if (typeof u !== 'object' || u === null) return { autoCheck: true };
  const x = u as Partial<UpdatePrefs>;
  return {
    autoCheck: x.autoCheck !== false,
    // Bounded: the value arrives over IPC from the renderer, and every other
    // sanitizer in this file refuses to write something arbitrary to disk. A
    // version string is never anywhere near this long.
    ...(typeof x.skippedVersion === 'string' && x.skippedVersion
      ? { skippedVersion: x.skippedVersion.slice(0, 64) }
      : {}),
    ...(typeof x.lastCheck === 'string' && x.lastCheck ? { lastCheck: x.lastCheck } : {}),
    // E19-04's handshake. Bounded like `skippedVersion`, and an empty string
    // drops the key entirely — that is how `resolveHandshake` clears it, so
    // "cleared" has to mean absent on disk rather than a lingering `""`.
    ...(typeof x.pendingUpdateVersion === 'string' && x.pendingUpdateVersion
      ? { pendingUpdateVersion: x.pendingUpdateVersion.slice(0, 64) }
      : {}),
  };
}

function sanitizeWindow(w: unknown): PersistedWindow | null {
  if (typeof w !== 'object' || w === null) return null;
  const fp = (w as { displayFingerprint?: unknown }).displayFingerprint;
  if (typeof fp !== 'string') return null;
  const merged = mergeState(w);
  return { ...merged, displayFingerprint: fp };
}
