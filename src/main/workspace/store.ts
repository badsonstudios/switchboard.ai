// Workspace store (P1-E2-04, §5.25/§7): the single persisted picture of the
// workspace — session records (identity, layout slot, provider-native id for
// resume) and window geometry with a display fingerprint. Restore-on-launch
// yields SUSPENDED session records; actual relaunch is resume-on-focus
// (§5.25) — the UI layer (E3) turns a touched suspended card into
// SessionManager.create({...identity}, {resumeSessionId: nativeSessionId}).
//
// Persistence rules: tolerant load (corrupt file -> backed aside under a
// timestamped, write-once name, fresh start — never crash on our own state, and
// never destroy an earlier post-mortem: #349) but never a SILENT one: every repair
// load makes, up to and including throwing the whole file away, writes a warn
// naming what it cost (#344). Atomic save (tmp + rename),
// debounced save-soon for churny callers, and a version dispatch on the way in
// (§5.26) — a file from a FUTURE version is shown but never written back.
import fs from 'fs';
import path from 'path';
import { Rectangle } from 'electron';
import { LogFields, Logger } from '../log/logger';
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
    // Everything this load has to say, COLLECTED rather than logged where it is
    // found (#344) and emitted at the bottom. A warn raised inside the `try`
    // below would, if the logger ever threw, land in the corrupt-file `catch` —
    // a diagnostic that destroys the workspace it was diagnosing, which
    // fail-open (P6) says must not be possible.
    //
    // Two lists, because that `catch` treats them differently: what is true of
    // the FILE stands whatever happens next, while a repair describes the state
    // being built — and the catch throws that state away.
    const fileNotes: LoadNote[] = [];
    const repairNotes: LoadNote[] = [];
    /**
     * Note a repair. Silent while READ-ONLY: a file from the future is not
     * damaged, this build just cannot read all of it, nothing is written back,
     * and the read-only line already says so — "those cards do not come back"
     * would be a lie about a file that still has them.
     */
    const note = (msg: string, fields?: LogFields): void => {
      if (!this.readOnly) repairNotes.push({ msg, fields });
    };
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
        fileNotes.push({
          msg: 'workspace file was written by a newer version of switchboard.ai — loading it read-only; changes made this run will NOT be saved',
          fields: { fileVersion, supportedVersion: CURRENT_VERSION },
        });
      }
      // Unknown future versions have no migration; fall through to the current
      // reader and let the sanitizer keep whatever still makes sense. (Nothing
      // below is reset in the `catch` on purpose: if the sanitizer ever chokes
      // on a future file, staying read-only is the safe half of the failure.)
      const raw = (MIGRATIONS[fileVersion] ?? passthrough)(obj) as Partial<WorkspaceState>;
      const groups = keepSane(raw.groups, isSaneGroup, 'group', note).map((g) => {
        const repaired = repairGroupName(g);
        // identity compare: the repair hands BACK the same object when the
        // name was fine, so a new one means it stepped in
        if (repaired !== g)
          note('a group in the workspace file had a blank name — using a placeholder', {
            groupId: g.id,
            name: PLACEHOLDER_GROUP_NAME,
          });
        return repaired;
      });
      const groupIds = new Set(groups.map((g) => g.id));
      // a dangling groupId (group gone, e.g. hand-edited file) degrades to ungrouped
      const orphaned: string[] = [];
      const sessions = keepSane(raw.sessions, isSaneSession, 'session', note).map((s) => {
        if (!s.groupId || groupIds.has(s.groupId)) return s;
        orphaned.push(s.id);
        return { ...s, groupId: undefined };
      });
      if (orphaned.length > 0)
        note(
          'sessions in the workspace file named a group that is not in it — loading them ungrouped',
          // bounded like everything else this file writes: one bad `groups`
          // entry can orphan every session in the workspace
          { sessionIds: orphaned.slice(0, MAX_LISTED_IDS), count: orphaned.length }
        );

      const window = sanitizeWindow(raw.window);
      if (window.repaired.length > 0)
        note(
          // the consequence differs: losing the whole record (or the rect)
          // centres the window, losing only `isMaximized` does not move it
          window.value?.bounds
            ? 'part of the saved window state in the workspace file was unusable — using the default for it'
            : 'the saved window position in the workspace file was unusable — opening centred at the default size',
          { unusable: window.repaired }
        );

      const notifications = sanitizeNotifications(raw.notifications);
      if (notifications.repaired.length > 0)
        note('notification settings in the workspace file were unusable — using the defaults', {
          unusable: notifications.repaired,
        });

      const updates = sanitizeUpdates(raw.updates);
      if (updates.repaired.length > 0)
        note('update settings in the workspace file were unusable — using the defaults', {
          unusable: updates.repaired,
        });

      if (wrongType(raw, 'autoTrust', 'boolean'))
        note('the auto-trust setting in the workspace file was not true or false — leaving it on');

      this.state = {
        version: CURRENT_VERSION,
        sessions,
        groups,
        window: window.value,
        layout: raw.layout ?? null,
        ui: raw.ui ?? null,
        notifications: notifications.value,
        autoTrust: raw.autoTrust !== false, // default on
        updates: updates.value,
      };
    } catch (err) {
      // corrupt/missing: back the corpse aside (post-mortem material), start fresh
      //
      // This used to be `void err;` — the reason, the fact, and the set-aside
      // path all thrown away (#344). It is the loudest thing this store can do
      // to a user (every card, group and pane gone, a workspace that looks
      // factory-fresh) and it was the only failure here with nothing written
      // anywhere. Nothing is surfaced in the UI yet — that posture question is
      // #207's — so the log line is the whole diagnosis.
      repairNotes.length = 0; // they described a state this catch just binned
      if (fs.existsSync(this.file)) {
        const aside = this.setAsideCorruptFile();
        fileNotes.push({
          msg: 'workspace file could not be read — starting with an empty workspace; the sessions, groups and layout it held are not restored',
          fields: {
            // the stack, not just the message: this catch is also the net for a
            // sanitizer that chokes on a hand-edited file, and there the frame
            // IS the diagnosis (a JSON syntax error reads the same either way)
            error: err instanceof Error && err.stack ? err.stack : String(err),
            ...aside,
          },
        });
      }
      // A file that is simply ABSENT is first launch, not a fault: no warn.
      this.state = emptyState();
    }
    for (const n of [...fileNotes, ...repairNotes]) {
      try {
        this.log?.warn(n.msg, { file: this.file, ...n.fields });
      } catch {
        // Saying what broke must never be the thing that breaks (P6). Also the
        // reason these run out here: a throw INSIDE the try above would have
        // been read as a corrupt file.
      }
    }
    return this.snapshot();
  }

  /**
   * Set the unreadable workspace file aside for the post-mortem, under a name
   * nothing has used before (#349).
   *
   * The set-aside used to be one fixed path, `workspace.json.corrupt`, which a
   * SECOND bad load overwrote — destroying the copy of the ORIGINAL corruption,
   * the one that explains how this started. So each set-aside gets its own
   * timestamped name and is written with `COPYFILE_EXCL`: this path can create a
   * post-mortem, and can delete an old one by retention policy, but it can never
   * overwrite one — not even if the clock repeats a millisecond or runs
   * backwards (a VM snapshot, an NTP correction, a user fixing a wrong clock).
   *
   * Write-once naming rather than rotating `.corrupt` → `.corrupt.1` (the
   * logger's idiom) on purpose: rotation has to RENAME existing files on the one
   * code path that runs when the disk is already misbehaving, and a rename that
   * fails there loses the very file it was protecting. And the name carries the
   * *when*, which survives being copied into a bug report — an mtime does not.
   *
   * Fail-open (P6): every failure here becomes a field on the warn `load()` is
   * already writing. Nothing throws, and nothing stops the empty-workspace boot.
   */
  private setAsideCorruptFile(): LogFields {
    const stamp = new Date().toISOString().replace(/:/g, '-'); // ':' is illegal on Windows
    const base = `${this.file}.corrupt-${stamp}`;
    for (let attempt = 1; attempt <= MAX_STAMP_ATTEMPTS; attempt++) {
      // A stamp already on disk means the clock repeated (or went back). Take a
      // single-digit suffix rather than the file someone else already wrote.
      const dest = attempt === 1 ? base : `${base}.${attempt}`;
      try {
        fs.copyFileSync(this.file, dest, fs.constants.COPYFILE_EXCL);
      } catch (copyErr) {
        if ((copyErr as NodeJS.ErrnoException).code === 'EEXIST') continue;
        return { setAsideError: String(copyErr) }; // best-effort, but no longer secret
      }
      // Prune only once a NEW post-mortem is safely on disk — spending the
      // history to make room for a copy that never happened would be the bug
      // this fixed, with extra steps — and OUTSIDE the copy's try/catch, so a
      // prune that somehow throws cannot be reported as a failed copy.
      return { setAside: dest, ...this.pruneSetAsides(dest) };
    }
    return { setAsideError: `no unused set-aside name beside ${base}` };
  }

  /**
   * Bound the post-mortems on disk to `MAX_SET_ASIDES`, so a workspace file that
   * fails to load on every launch cannot fill a disk.
   *
   * **The oldest one is never pruned.** It is the copy of the corruption that
   * STARTED this — the whole reason #349 exists — so what goes is the middle:
   * the newest few (the current symptom) and the first (the origin) both stay.
   *
   * `justWritten` is excluded from the candidates rather than trusted to sort
   * last: if the clock ran backwards, this load's own set-aside would otherwise
   * be a prune candidate, and the one log line would name a file it had just
   * deleted.
   *
   * Only names this code itself writes are considered — the prefix AND a
   * well-formed stamp, files only. A bare `workspace.json.corrupt` from an older
   * build, a `workspace.json.corrupt-KEEP-THIS` the user renamed, and a stray
   * directory are all left exactly where they are.
   */
  private pruneSetAsides(justWritten: string): LogFields {
    const dir = path.dirname(this.file);
    const prefix = `${path.basename(this.file)}.corrupt-`;
    const mine = path.basename(justWritten);
    let names: string[];
    try {
      names = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(
          (e) =>
            e.isFile() &&
            e.name !== mine &&
            e.name.startsWith(prefix) &&
            STAMPED_SUFFIX.test(e.name.slice(prefix.length))
        )
        .map((e) => e.name)
        .sort(); // fixed-width ISO stamps: name order IS chronological order
    } catch (readErr) {
      return { pruneListError: String(readErr) }; // distinct from a failed DELETE
    }
    // Two of the five slots are already committed — `justWritten` and the spared
    // oldest — so the newest survivors number MAX_SET_ASIDES - 2, and starting
    // the slice at 1 is what spares that oldest.
    const doomed = names.slice(1, Math.max(1, names.length - (MAX_SET_ASIDES - 2)));
    const pruned: string[] = [];
    const errors: string[] = [];
    for (const name of doomed) {
      try {
        fs.rmSync(path.join(dir, name));
        pruned.push(path.join(dir, name));
      } catch (rmErr) {
        // a file someone else already deleted is not a failure to delete it
        if ((rmErr as NodeJS.ErrnoException).code === 'ENOENT') continue;
        errors.push(String(rmErr));
      }
    }
    return {
      // deleting a post-mortem is a real loss, so it rides along on the same
      // line rather than going unsaid — bounded like every other list here
      ...(pruned.length > 0
        ? { pruned: pruned.slice(0, MAX_LISTED_IDS), prunedCount: pruned.length }
        : {}),
      ...(errors.length > 0
        ? {
            pruneError: errors.slice(0, MAX_LISTED_ERRORS).join('; '),
            pruneErrorCount: errors.length,
          }
        : {}),
    };
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
    this.state.notifications = sanitizeNotifications({ ...this.state.notifications, ...p }).value;
    this.saveSoon();
  }

  getUpdatePrefs(): UpdatePrefs {
    return { ...this.state.updates };
  }

  /** Merge-patch, for the reason the notification prefs are (review P1 #13). */
  setUpdatePrefs(p: Partial<UpdatePrefs>): void {
    this.state.updates = sanitizeUpdates({ ...this.state.updates, ...p }).value;
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

/**
 * What a sanitizer produced, plus the field names it had to step in on (#344).
 *
 * The sanitizers stay pure and stay the single place that knows what "usable"
 * means; `load()` is the only caller that turns a repair into a log line —
 * `setNotificationPrefs`/`setUpdatePrefs` run the same code on live IPC input,
 * where a rejected field is the API working, not a file going wrong.
 */
interface Repaired<T> {
  value: T;
  /** field names that were present but unusable — empty means nothing moved */
  repaired: string[];
}

/**
 * Is `key` present in `o` but of the wrong type — i.e. a REPAIR rather than a
 * default? `undefined` and `null` are "not saved" and never count: a first
 * launch, an older file that predates a field, and an explicit null all mean
 * the same thing to the reader, and warning about them would make every launch
 * noisy for nothing.
 */
function wrongType(o: object, key: string, type: 'string' | 'boolean'): boolean {
  const v = (o as Record<string, unknown>)[key];
  return v !== undefined && v !== null && typeof v !== type;
}

/** A warn `load()` decided on, emitted once the load is over. See `load()`. */
interface LoadNote {
  msg: string;
  fields?: LogFields;
}

/** How many ids one log line may name before it just carries the count. */
const MAX_LISTED_IDS = 20;

/**
 * How many `workspace.json.corrupt-<stamp>` post-mortems are kept beside the
 * workspace file (#349). Five, matching the log sink's rotated-file default for
 * the same reason: enough history to see a repeating failure, bounded so one
 * cannot fill a disk. Each is a few KB. Which five: see `pruneSetAsides`.
 */
const MAX_SET_ASIDES = 5;

/** Names `pruneSetAsides` will act on — the stamp `setAsideCorruptFile` writes,
 *  with the optional collision suffix. Anything else in that namespace is a
 *  human's file and is never touched. */
const STAMPED_SUFFIX = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z(\.\d)?$/;

/** Names tried for one set-aside before giving up: the stamp, then `.2`…`.9`. */
const MAX_STAMP_ATTEMPTS = 9;

/** How many failures one log field spells out; the rest are just counted. Lower
 *  than `MAX_LISTED_IDS` because each of these is a whole error string. */
const MAX_LISTED_ERRORS = 3;

/** What each list costs the user when entries in it cannot be read. */
const LOST: Record<'session' | 'group', string> = {
  session: 'those cards do not come back',
  group: 'any sessions in them load ungrouped',
};

/**
 * Keep the entries of a persisted list this build can actually use, noting what
 * was thrown away (#344).
 *
 * Absent or `null` is an empty workspace, not a repair — a first launch must
 * stay silent. A non-list where a list belongs IS one, and the LOUDER of the
 * two: it costs the user everything the list held, not some of it.
 */
function keepSane<T>(
  raw: unknown,
  sane: (v: unknown) => v is T,
  what: 'session' | 'group',
  note: (msg: string, fields?: LogFields) => void
): T[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    note(`the ${what} list in the workspace file was not a list — ignoring all of it; ${LOST[what]}`);
    return [];
  }
  const kept = (raw as unknown[]).filter(sane);
  if (kept.length < raw.length)
    note(
      `some ${what} entries in the workspace file were unusable and were dropped — ${LOST[what]}`,
      { dropped: raw.length - kept.length, kept: kept.length }
    );
  return kept;
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

/** Which of `keys` are present in `o` but the wrong type, in the order given. */
function badFields(o: object, keys: readonly [string, 'string' | 'boolean'][]): string[] {
  return keys.filter(([k, t]) => wrongType(o, k, t)).map(([k]) => k);
}

function sanitizeNotifications(n: unknown): Repaired<NotificationPrefsState> {
  // A whole block that is not an object (an ARRAY is not one either) loses
  // every setting in it at once, so it is named as one repair rather than
  // field by field.
  if (typeof n !== 'object' || n === null || Array.isArray(n))
    return { value: { enabled: true }, repaired: n == null ? [] : ['notifications'] };
  const x = n as Partial<NotificationPrefsState>;
  return {
    value: {
      enabled: x.enabled !== false,
      osToasts: x.osToasts === true, // default OFF
      ...(typeof x.quietStart === 'string' ? { quietStart: x.quietStart } : {}),
      ...(typeof x.quietEnd === 'string' ? { quietEnd: x.quietEnd } : {}),
    },
    repaired: badFields(n, [
      ['enabled', 'boolean'],
      ['osToasts', 'boolean'],
      ['quietStart', 'string'],
      ['quietEnd', 'string'],
    ]),
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
function sanitizeUpdates(u: unknown): Repaired<UpdatePrefs> {
  if (typeof u !== 'object' || u === null || Array.isArray(u))
    return { value: { autoCheck: true }, repaired: u == null ? [] : ['updates'] };
  const x = u as Partial<UpdatePrefs>;
  const value: UpdatePrefs = {
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
  return {
    value,
    repaired: badFields(u, [
      ['autoCheck', 'boolean'],
      ['skippedVersion', 'string'],
      ['lastCheck', 'string'],
      ['pendingUpdateVersion', 'string'],
    ]),
  };
}

function sanitizeWindow(w: unknown): Repaired<PersistedWindow | null> {
  // No saved window at all — a first launch. Not a repair.
  if (w === undefined || w === null) return { value: null, repaired: [] };
  // Present but not a window record: the whole saved position is lost.
  if (typeof w !== 'object' || Array.isArray(w)) return { value: null, repaired: ['window'] };
  const fp = (w as { displayFingerprint?: unknown }).displayFingerprint;
  if (typeof fp !== 'string') return { value: null, repaired: ['displayFingerprint'] };
  const merged = mergeState(w);
  const bounds = (w as { bounds?: unknown }).bounds;
  const repaired = badFields(w, [['isMaximized', 'boolean']]);
  // `bounds: null` is a legitimate saved value (a rescued window); only bounds
  // that were WRITTEN and came back unusable — non-finite, or below the minimum
  // size mergeState enforces — count as a repair.
  if (bounds !== undefined && bounds !== null && merged.bounds === null) repaired.unshift('bounds');
  return { value: { ...merged, displayFingerprint: fp }, repaired };
}
