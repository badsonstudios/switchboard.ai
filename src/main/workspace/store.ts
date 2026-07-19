// Workspace store (P1-E2-04, §5.25/§7): the single persisted picture of the
// workspace — session records (identity, layout slot, provider-native id for
// resume) and window geometry with a display fingerprint. Restore-on-launch
// yields SUSPENDED session records; actual relaunch is resume-on-focus
// (§5.25) — the UI layer (E3) turns a touched suspended card into
// SessionManager.create({...identity}, {resumeSessionId: nativeSessionId}).
//
// Persistence rules: tolerant load (corrupt file -> backed aside, fresh
// start — never crash on our own state), atomic save (tmp + rename),
// debounced save-soon for churny callers.
import fs from 'fs';
import path from 'path';
import { Rectangle } from 'electron';
import { SessionIdentity } from '../sessions/session-manager';
import { WindowState, mergeState, isOnAnyDisplay } from '../window-state';

export interface PersistedSession {
  id: string;
  identity: SessionIdentity;
  layoutSlot: number;
  nativeSessionId?: string;
  suspendedAt: string;
}

export interface PersistedWindow extends WindowState {
  displayFingerprint: string;
}

export interface NotificationPrefsState {
  enabled: boolean;
  quietStart?: string;
  quietEnd?: string;
}

export interface WorkspaceState {
  version: 1;
  sessions: PersistedSession[];
  window: PersistedWindow | null;
  /** opaque grid-layout JSON owned by the renderer (Dockview serialization) */
  layout: unknown;
  notifications: NotificationPrefsState;
  /** auto-trust a folder on session open (picking a folder = trusting it) */
  autoTrust: boolean;
}

const EMPTY: WorkspaceState = {
  version: 1,
  sessions: [],
  window: null,
  layout: null,
  notifications: { enabled: true },
  autoTrust: true,
};

/** Stable identity for a display arrangement (§7). */
export function displayFingerprint(workAreas: Rectangle[]): string {
  return workAreas
    .map((a) => `${a.x},${a.y},${a.width},${a.height}`)
    .sort()
    .join('|');
}

export class WorkspaceStore {
  private state: WorkspaceState = EMPTY;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {}

  load(): WorkspaceState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<WorkspaceState>;
      this.state = {
        version: 1,
        sessions: Array.isArray(raw.sessions) ? raw.sessions.filter(isSaneSession) : [],
        window: sanitizeWindow(raw.window),
        layout: raw.layout ?? null,
        notifications: sanitizeNotifications(raw.notifications),
        autoTrust: raw.autoTrust !== false, // default on
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
      this.state = { ...EMPTY, sessions: [] };
      void err;
    }
    return this.snapshot();
  }

  snapshot(): WorkspaceState {
    return JSON.parse(JSON.stringify(this.state)) as WorkspaceState;
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

  getNotificationPrefs(): NotificationPrefsState {
    return { ...this.state.notifications };
  }

  setNotificationPrefs(p: NotificationPrefsState): void {
    this.state.notifications = sanitizeNotifications(p);
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

  save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
    } catch {
      /* persistence is best-effort — never take the app down (fail-open) */
    }
  }

  saveSoon(): void {
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

function sanitizeNotifications(n: unknown): NotificationPrefsState {
  if (typeof n !== 'object' || n === null) return { enabled: true };
  const x = n as Partial<NotificationPrefsState>;
  return {
    enabled: x.enabled !== false,
    ...(typeof x.quietStart === 'string' ? { quietStart: x.quietStart } : {}),
    ...(typeof x.quietEnd === 'string' ? { quietEnd: x.quietEnd } : {}),
  };
}

function sanitizeWindow(w: unknown): PersistedWindow | null {
  if (typeof w !== 'object' || w === null) return null;
  const fp = (w as { displayFingerprint?: unknown }).displayFingerprint;
  if (typeof fp !== 'string') return null;
  const merged = mergeState(w);
  return { ...merged, displayFingerprint: fp };
}
