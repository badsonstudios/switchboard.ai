// Workspace store (P1-E2-04, §5.25/§7): the single persisted picture of the
// workspace — session records (identity, layout slot, provider-native id for
// resume) and window geometry with a display fingerprint. Restore-on-launch
// yields SUSPENDED session records; actual relaunch is resume-on-focus
// (§5.25) — the UI layer (E3) turns a touched suspended card into
// SessionManager.create({...identity}, {resumeSessionId: nativeSessionId}).
//
// Persistence rules: tolerant load (corrupt file -> backed aside under a
// timestamped, write-once name, fresh start — never crash on our own state, and
// never destroy an earlier post-mortem: #349; when that copy FAILS the damaged
// file is the only evidence left, so the first save is held back and tries
// again rather than overwriting it: #352) but never a SILENT one: every repair
// load makes, up to and including throwing the whole file away, writes a warn
// naming what it cost (#344). Atomic save (tmp + rename), which RETRIES on
// failure and — once it has failed enough times in a row to mean something —
// says so on screen rather than only in the log (#207),
// debounced save-soon for churny callers, and a version dispatch on the way in
// (§5.26) — a file from a FUTURE version is shown but never written back.
import fs from 'fs';
import path from 'path';
import { Rectangle } from 'electron';
import { LogFields, Logger } from '../log/logger';
import { SessionIdentity } from '../sessions/session-manager';
import { WindowState, mergeState, isOnAnyDisplay } from '../window-state';
import { UpdatePrefs } from '../../shared/update';
import { WorkspaceSaveState } from '../../shared/workspace';

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
   * Which transport this card's sessions run on (P2-E18-08b). Stored per CARD,
   * not per live session, so the choice survives a resume the same way autonomy
   * does.
   *
   * **Absent means "this card has never chosen", NOT "chose the PTY"** — so an
   * absent field follows `DEFAULT_SESSION_TRANSPORT` (`main/transport/
   * transport.ts`) at the moment the session starts, whatever that is then.
   * Which is how #381 moved every untouched card to Direct in one line, and how
   * a future change of default would move them again. Cards that predate the
   * setting are exactly this population.
   *
   * It said "absent = `pty`, stream mode ships OPT-IN" until #381 flipped the
   * default; only the default changed, not the meaning of the field. A card
   * with a VALUE here keeps it, Terminal included — that is the promise that
   * makes the default safe to flip, and `sessions:create` is where the two are
   * ordered.
   */
  transport?: 'pty' | 'stream';
  /** freeform "what is this doing" label, distinct from the folder title */
  taskLabel?: string;
  /**
   * Who set `taskLabel` (P2-E7-06, §5.11): the user typed it, or it was filled
   * from the CLI's own conversation title. `'user'` is sticky for ever;
   * `'auto'` keeps tracking.
   *
   * ABSENT ON EVERY CARD WRITTEN BEFORE THIS FEATURE, and the meaning of that
   * absence matters — those cards may carry a label the user typed under E7-03.
   * `sessions/auto-label.ts` reads it, and treats "absent with text in it" as
   * the user's; nothing here needs a migration because that rule is exact.
   */
  labelSource?: 'auto' | 'user';
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
   * Fill a blank task label from the CLI's own conversation title (P2-E7-06,
   * §5.11). Default ON — it is the feature.
   *
   * The off-switch exists for one concrete reason and it is not squeamishness:
   * the label is derived from what the user asked the agent, and it renders on
   * the card, in the rail and in OS toasts, which is to say it leaves the app
   * window and lands in a screen-share. Turning it off hides every auto label
   * at once and drops toast text back to the session title.
   *
   * A workspace setting beside `autoTrust`, not a notification pref, even though
   * §5.11 files it under §5.9: notification prefs are about notifications, and
   * this governs the card first and the toast second.
   */
  autoLabels: boolean;
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
  autoLabels: true,
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
  /**
   * The damaged workspace file this load could NOT set aside, kept so the first
   * save does not destroy the only copy of it (#352). Null on every normal run
   * — and null again the moment the copy lands or is given up on.
   */
  private unsavedPostMortem: PendingPostMortem | null = null;
  /** consecutive `save()` attempts that threw; zero the moment one works */
  private saveFailures = 0;
  /** the streak has gone on long enough to be worth a banner (#207) */
  private saveFailing = false;
  /** how long the next retry waits — doubles per failure, capped */
  private saveRetryMs = 0;

  /**
   * @param onSaveState called whenever the answer to "can this workspace still
   * be saved?" CHANGES (#207) — main forwards it to the renderer, which puts a
   * notice on screen. Never called for a one-off failure, and never called at
   * all on a run where saving works. Optional: the store is fully functional
   * without a listener, and a listener that throws is swallowed (P6).
   */
  constructor(
    private readonly file: string,
    private readonly log?: Logger,
    private readonly onSaveState?: (state: WorkspaceSaveState) => void
  ) {}

  load(): WorkspaceState {
    this.readOnly = false;
    // Both of these describe the file THIS load found; a re-load starts from
    // neither of them.
    this.unsavedPostMortem = null;
    // …and so does the save health: whatever the last file's writes were doing
    // says nothing about this one's. The timer goes with it — a retry armed
    // against the file we are replacing would fire against the new one, which
    // is harmless today (one `load()` per process) and is exactly the sort of
    // thing that stops being harmless quietly.
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.clearSaveFailures();
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
    // Held outside the try so the catch can keep what was read: if the copy
    // below fails, these bytes are the only post-mortem left anywhere (#352).
    // Null when the READ is what failed — then there is nothing to hold.
    let rawBytes: Buffer | null = null;
    try {
      rawBytes = fs.readFileSync(this.file);
      const parsed: unknown = JSON.parse(rawBytes.toString('utf8'));
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

      if (wrongType(raw, 'autoLabels', 'boolean'))
        note('the auto-label setting in the workspace file was not true or false — leaving it on');

      this.state = {
        version: CURRENT_VERSION,
        sessions,
        groups,
        window: window.value,
        layout: raw.layout ?? null,
        ui: raw.ui ?? null,
        notifications: notifications.value,
        autoTrust: raw.autoTrust !== false, // default on
        autoLabels: raw.autoLabels !== false, // default on — same shape, same reason
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
        const aside = this.setAsideCorruptFile(rawBytes);
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
    // Out here, not where each note was made: a throw INSIDE the try above
    // would have been read as a corrupt file. (`warn` itself cannot throw.)
    for (const n of [...fileNotes, ...repairNotes]) this.warn(n.msg, n.fields);
    return this.snapshot();
  }

  /**
   * Say something about this file, without the saying ever becoming the failure
   * (P6) — a logger that throws must not cost the caller its workspace.
   */
  private warn(msg: string, fields?: LogFields): void {
    this.say('warn', msg, fields);
  }

  /** `warn`'s counterpart for good news — saving working again is not a fault. */
  private info(msg: string, fields?: LogFields): void {
    this.say('info', msg, fields);
  }

  private say(level: 'warn' | 'info', msg: string, fields?: LogFields): void {
    try {
      this.log?.[level](msg, { file: this.file, ...fields });
    } catch {
      // nothing left to try: the reporting channel is the thing that broke
    }
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
   * A failure is also REMEMBERED — see `rescuePostMortem` (#352).
   */
  private setAsideCorruptFile(bytes: Buffer | null): LogFields {
    const stamp = new Date().toISOString().replace(/:/g, '-'); // ':' is illegal on Windows
    const landed = this.intoFreshSetAside(stamp, (dest) =>
      fs.copyFileSync(this.file, dest, fs.constants.COPYFILE_EXCL)
    );
    // Prune only once a NEW post-mortem is safely on disk — spending the
    // history to make room for a copy that never happened would be the bug
    // this fixed, with extra steps — and OUTSIDE the copy's try/catch, so a
    // prune that somehow throws cannot be reported as a failed copy.
    if (landed.dest) return { setAside: landed.dest, ...this.pruneSetAsides(landed.dest) };
    // Read-only, so no save will ever reach that file: there is nothing to
    // protect it FROM, and promising a retry that can never run (never mind
    // pinning its bytes for the life of the process) would be a lie in the log.
    // Reachable only via the future-version file whose reader then throws —
    // see the `catch` this was called from.
    if (this.readOnly) return { setAsideError: landed.error };
    // The copy failed, so the damaged file is STILL the only copy of the
    // evidence — and it is exactly the file the next save writes over (#352).
    // Keep what we managed to read and try again before that happens.
    this.unsavedPostMortem = {
      stamp,
      // Bounded: this is pinned for as long as the rescue takes, and a real
      // workspace.json is a few KB. A file too big to hold is not held — the
      // copy and move routes below need no bytes at all.
      bytes: bytes && bytes.length <= MAX_HELD_POST_MORTEM_BYTES ? bytes : null,
      attempts: 0,
    };
    return { setAsideError: landed.error, setAsideRetry: true };
  }

  /**
   * Put a post-mortem at the first `…corrupt-<stamp>` name nothing has used,
   * with whatever `put` does.
   *
   * `put` MUST refuse an existing name with `EEXIST` rather than overwrite it —
   * that refusal is the whole guarantee #349 bought, and every caller here has
   * one: `COPYFILE_EXCL`, the `wx` write flag, and the explicit check the move
   * makes. A stamp already on disk means the clock repeated (or went back);
   * take a single-digit suffix rather than the file someone else already wrote.
   */
  private intoFreshSetAside(
    stamp: string,
    put: (dest: string) => void
  ): { dest?: string; error?: string } {
    const base = `${this.file}.corrupt-${stamp}`;
    for (let attempt = 1; attempt <= MAX_STAMP_ATTEMPTS; attempt++) {
      const dest = attempt === 1 ? base : `${base}.${attempt}`;
      try {
        put(dest);
        return { dest };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        return { error: String(err) }; // best-effort, but no longer secret
      }
    }
    return { error: `no unused set-aside name beside ${base}` };
  }

  /**
   * Last chance to keep the evidence, run immediately before the write that
   * would destroy it (#352).
   *
   * #349 made the SUCCESS path safe; this is the failure path. When the copy at
   * load time did not land, the damaged `workspace.json` is the only remaining
   * record of what went wrong — on exactly the class of machine (full disk,
   * anti-virus holding a handle) whose owner most needs one — and the first
   * `saveSoon()` of the fresh empty workspace lands on top of it.
   *
   * Three ways in, tried in order, because the reason the first copy failed is
   * not known (the first two are alternatives — whether the bytes were held
   * decides which of them is even possible):
   *
   * 1. **write the bytes we read** — the most faithful copy, and the only one
   *    that still works if the damaged file has since become unreadable;
   * 2. **copy it** — for when the READ is what failed, so there are no bytes;
   * 3. **move it** — last, and the one that works on a FULL disk, where nothing
   *    can be written but a rename inside a directory costs nothing. Safe here
   *    and nowhere else in this file: we are one statement from destroying that
   *    file anyway, so moving it can only be an improvement.
   *
   * Returns whether the save may proceed. `false` means "not yet" — the save is
   * re-armed and the state stays in memory; boot, the UI and every session are
   * untouched, which is what fail-open asks for here. Nothing is held back
   * forever: after `MAX_RESCUE_ATTEMPTS` the workspace wins and the loss is
   * said out loud, because a workspace that can never be saved again would be a
   * worse bug than the one this fixes.
   *
   * The one thing a deferral can cost: `save()` is also the quit-time FLUSH
   * (`win.on('close')`, and the update handshake), and a flush deferred is a
   * flush lost — the process does not live long enough for the retry. That is
   * still the right trade, and it is why neither call site gets a bypass. The
   * evidence is not lost by quitting: the damaged file is untouched on disk, so
   * the next launch diagnoses it and sets it aside all over again. What is lost
   * is one run's workspace — a run that by definition started empty, seconds
   * ago, and whose save said in the log that it was being held (#165).
   */
  private rescuePostMortem(): boolean {
    const held = this.unsavedPostMortem;
    if (!held) return true;
    // Nothing left to protect: no bytes in hand, and the damaged file itself is
    // gone (a user moved it, or an earlier rescue's move did).
    if (!held.bytes && !fs.existsSync(this.file)) {
      this.unsavedPostMortem = null;
      return true;
    }
    const fields = this.retrySetAside(held);
    if (fields.setAside) {
      this.unsavedPostMortem = null;
      this.warn(
        'the damaged workspace file was set aside on a later try — saving the empty workspace over it now',
        fields
      );
      return true;
    }
    held.attempts++;
    if (held.attempts < MAX_RESCUE_ATTEMPTS) {
      // Said once, on the first deferral: a run whose saves are being held back
      // is not something to discover only by their absence.
      if (held.attempts === 1)
        this.warn(
          'not saving over the damaged workspace file yet — it is the only copy of what went wrong and it could not be set aside; retrying',
          fields
        );
      this.saveTimer = setTimeout(() => this.save(), RESCUE_RETRY_MS);
      this.saveTimer.unref?.();
      return false;
    }
    this.unsavedPostMortem = null;
    this.warn(
      'could not set the damaged workspace file aside — saving over it; there will be no copy of it to look at',
      { ...fields, attempts: held.attempts }
    );
    return true;
  }

  /** `rescuePostMortem`'s routes, in order — at most two of the three apply to
   *  any one attempt. Reported the way the first attempt was: one `setAside`
   *  (plus how it got there), or one collected `setAsideError`. */
  private retrySetAside(held: PendingPostMortem): LogFields {
    const bytes = held.bytes;
    // The two routes that go through the damaged FILE are only offered while
    // there is one; otherwise they contribute an `ENOENT` apiece to every
    // report, which reads like a disk problem and is not one.
    const stillThere = fs.existsSync(this.file);
    const routes: Route[] = [];
    if (bytes) routes.push(['written-from-memory', (dest) => writeNew(dest, bytes)]);
    else if (stillThere)
      routes.push(['copied', (dest) => fs.copyFileSync(this.file, dest, fs.constants.COPYFILE_EXCL)]);
    if (stillThere)
      routes.push([
        'moved',
        (dest) => {
          // `renameSync` REPLACES an existing destination on both platforms —
          // the only operation in this file that could destroy an older
          // post-mortem — so the name is checked first. Nothing else writes
          // these names (#289's single-instance lock), which is what makes a
          // check-then-act enough here.
          if (fs.existsSync(dest))
            throw Object.assign(new Error(`EEXIST: ${dest} exists`), { code: 'EEXIST' });
          fs.renameSync(this.file, dest);
        },
      ]);
    const errors: string[] = [];
    for (const [how, put] of routes) {
      const landed = this.intoFreshSetAside(held.stamp, put);
      if (landed.dest)
        return { setAside: landed.dest, setAsideHow: how, ...this.pruneSetAsides(landed.dest) };
      errors.push(`${how}: ${landed.error}`);
    }
    return { setAsideError: errors.join('; ') };
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

  getAutoLabels(): boolean {
    return this.state.autoLabels;
  }

  setAutoLabels(on: boolean): void {
    this.state.autoLabels = on;
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

  /**
   * Whether saving is currently failing, for a window that wants to say so
   * (#207). The push is `onSaveState`; this is the read a window makes when it
   * opens, because a window that starts up mid-failure has missed the change.
   */
  saveState(): WorkspaceSaveState {
    return { failing: this.saveFailing, file: this.file };
  }

  save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.readOnly) return; // never downgrade a future-version file to v1
    // A damaged file that a failed set-aside left behind is still sitting at
    // `this.file`, and the rename below is what destroys it (#352). Nothing
    // pending is the normal case, and it answers instantly.
    //
    // A DEFERRAL IS NOT A FAILURE. This returns before the try, so a held-back
    // save never counts towards the streak below — deliberately (#207): the
    // hold is bounded, self-resolving, and ends in a save that works, so
    // counting it would flash a "saving is failing" notice at a user whose
    // saving is about to be fine. When the hold gives up and the disk really is
    // broken, the write below fails on its own and IS counted — which is how
    // #352's give-up reaches the screen, in the only case where it means
    // something to the person looking at it.
    if (!this.rescuePostMortem()) return;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
      this.saveSucceeded();
    } catch (err) {
      this.saveFailed(err);
    }
  }

  /**
   * The write threw (#165, #207).
   *
   * Persistence is best-effort — never take the app down (fail-open, P6). But
   * it was also SILENT, and this is the write that carries the whole layout:
   * every card, every group, every popped-out window. A failure here means the
   * next launch quietly restores a stale workspace with no hint as to why,
   * which is indistinguishable from the app forgetting on purpose.
   *
   * Two things happen, and the order matters less than the reason for each.
   *
   * **It is tried again.** The usual cause on Windows is a scanner or an
   * indexer holding the file for a moment (EPERM/EBUSY), and that is over in
   * well under a second. Without a retry the run's work sat unsaved until the
   * user happened to change something else — and with the app idle, that could
   * be never. Retries back off (1s, 2s, 4s… to `MAX_SAVE_RETRY_MS`) and do not
   * stop, because they are the only thing that can still save this run's work
   * AND the only thing that can notice the disk recovering. One small write
   * every ten seconds on an unref'd timer is a price worth paying for both.
   *
   * **After `SAVE_FAILURES_BEFORE_NOTICE` in a row it goes on screen.** Not on
   * the first: with the backoff above, a streak of three means saving has been
   * failing for about three seconds, which no transient handle survives. That
   * threshold is the whole difference between a notice that means something and
   * a banner that blinks at every anti-virus scan.
   */
  private saveFailed(err: unknown): void {
    this.saveFailures++;
    const error = String(err);
    // #165's line, unchanged, and still said the first time. Not repeated per
    // retry: a disk that has stopped taking writes would otherwise fill the log
    // with one identical line every ten seconds for the life of the process.
    if (this.saveFailures === 1)
      this.warn('workspace save failed — this run will not be restored', { error });
    if (!this.saveFailing && this.saveFailures >= SAVE_FAILURES_BEFORE_NOTICE) {
      this.saveFailing = true;
      this.warn('workspace saving keeps failing — saying so on screen', {
        error,
        attempts: this.saveFailures,
      });
      this.announceSaveState();
    }
    this.saveRetryMs = Math.min(
      this.saveRetryMs > 0 ? this.saveRetryMs * 2 : SAVE_RETRY_MS,
      MAX_SAVE_RETRY_MS
    );
    this.saveTimer = setTimeout(() => this.save(), this.saveRetryMs);
    this.saveTimer.unref?.();
  }

  /** The write landed. Silent on the overwhelmingly common path — there is
   *  nothing to undo and nothing to say. */
  private saveSucceeded(): void {
    const attempts = this.saveFailures;
    if (attempts === 0) return;
    this.clearSaveFailures();
    this.info('workspace saving recovered — this run will be restored after all', { attempts });
  }

  /**
   * Forget a failure streak, telling anyone watching if the SURFACED answer
   * changed. Recovery is the half of #207 the read-only notice never needed:
   * that condition lasts the whole run by definition, this one is expected to
   * end, and a notice that outlives its condition teaches people to ignore
   * notices.
   *
   * **No minimum display time, deliberately.** Saving that is genuinely
   * intermittent can raise the notice and drop it again — and in a popped-out
   * window that costs a dockview re-layout and a terminal re-fit each way (see
   * `WorkspaceNoticeBanner`). Holding the notice up for a grace period would
   * smooth that, and was rejected: it would mean `saveState()` reporting
   * `failing: true` over a store that is saving perfectly well, which is the
   * same class of lie this whole item exists to remove. Flapping is also
   * information — "your disk is intermittent" is worth seeing — and the
   * threshold already costs three consecutive failures, so the cycle floor is
   * seconds, not a strobe.
   */
  private clearSaveFailures(): void {
    this.saveFailures = 0;
    this.saveRetryMs = 0;
    if (!this.saveFailing) return;
    this.saveFailing = false;
    this.announceSaveState();
  }

  /** Tell the listener, without the telling ever becoming the failure (P6) —
   *  the same rule `warn` follows, for the same reason: this is called from
   *  inside `save()`, and a throw here would be a notice that costs a write. */
  private announceSaveState(): void {
    try {
      this.onSaveState?.(this.saveState());
    } catch {
      // a window that cannot be told is a missing notice; a save that dies
      // trying to tell it is the data loss the notice exists to report
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

/**
 * A post-mortem that has not made it to disk yet — the record `rescuePostMortem`
 * works from (#352). Its mere existence means "the damaged file must not be
 * overwritten yet".
 */
interface PendingPostMortem {
  /** the stamp the load picked, so the copy is named for WHEN the damage was
   *  found rather than for whenever the disk finally cooperated */
  stamp: string;
  /** the damaged file's bytes, when the read succeeded and they were small
   *  enough to hold; null means the rescue has to work from the file itself */
  bytes: Buffer | null;
  /** saves held back so far; see `MAX_RESCUE_ATTEMPTS` */
  attempts: number;
}

/** One way of getting a post-mortem onto disk: what to call it in the log, and
 *  what to do. See `retrySetAside`. */
type Route = [how: string, put: (dest: string) => void];

/**
 * Write `bytes` to a name nothing has used, leaving no half-file behind if the
 * write dies partway.
 *
 * Necessary because an `ENOSPC` two thirds of the way through leaves a
 * TRUNCATED post-mortem on the honest name — worse than none, and it would push
 * the route that does work onto `.2`.
 *
 * Whether the name was free BEFORE the attempt is what makes the cleanup safe,
 * and checking it is not paranoia: `wx` cannot truncate an existing file, but
 * it does not always come back as `EEXIST` either — Windows answers an existing
 * hidden or read-only file with `EPERM`/`EACCES`. Deleting on that would make
 * this the one function in the file that destroys a post-mortem it found.
 */
function writeNew(dest: string, bytes: Buffer): void {
  const wasFree = !fs.existsSync(dest);
  try {
    fs.writeFileSync(dest, bytes, { flag: 'wx' });
  } catch (err) {
    if (wasFree && (err as NodeJS.ErrnoException).code !== 'EEXIST') {
      try {
        fs.rmSync(dest, { force: true });
      } catch {
        // the disk is refusing everything; the throw below is the report
      }
    }
    throw err;
  }
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

/**
 * How many saves may be held back while a failed set-aside is retried (#352),
 * one attempt per save — a budget in SAVES, not in seconds, so a churny run
 * spends it faster than a quiet one (the retry timer only sets the floor:
 * roughly two to five seconds of grace for a transient handle). After that the
 * live workspace wins, because "never saves again" is a worse failure than "no
 * post-mortem".
 *
 * Reaching this is already unlikely to cost anything: a directory that refuses
 * to take a copy, a write and a rename will refuse the save's own tmp file too.
 */
const MAX_RESCUE_ATTEMPTS = 5;

/** Spacing of those retries — long enough that a busy scanner can finish. */
const RESCUE_RETRY_MS = 1000;

/**
 * Consecutive failed saves before the user is told on screen (#207).
 *
 * THREE, not one. A single EPERM/EBUSY from a backup agent or an indexer
 * touching `workspace.json` for a moment is an ordinary event on Windows and
 * the very next save works — a banner for that would be noise, and noise is
 * how a warning stops being read. With the backoff below, a third consecutive
 * failure means saving has been failing for roughly three seconds, which no
 * momentary handle survives.
 */
const SAVE_FAILURES_BEFORE_NOTICE = 3;

/** First retry after a failed save; doubles each time up to the cap. */
const SAVE_RETRY_MS = 1000;

/**
 * The slowest the retry gets. Retrying does not stop while saving is broken —
 * it is what eventually saves the run's work, and what notices the disk
 * recovering so the notice can come down — so the cadence has to settle
 * somewhere that costs nothing. Ten seconds is also the longest a user should
 * wait to see the banner clear after they fix whatever it was.
 */
const MAX_SAVE_RETRY_MS = 10_000;

/**
 * The largest unreadable workspace file whose bytes are pinned in memory while
 * the set-aside is retried (#352). A real one is a few KB; something orders of
 * magnitude bigger is not worth carrying for the life of the process, and the
 * copy/move routes rescue it without any bytes at all.
 */
const MAX_HELD_POST_MORTEM_BYTES = 4 * 1024 * 1024;

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
